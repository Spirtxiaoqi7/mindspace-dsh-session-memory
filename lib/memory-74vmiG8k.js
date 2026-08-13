import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { isCompactCheckpointSource } from "@deepseek-ai/dsh-compaction/checkpoint";
import { isReplacementSurfaceEvent } from "@deepseek-ai/dsh-session/surface";
import { BlockAssembler, createUserMessage, deepFreeze } from "@deepseek-ai/dsh-llm";
//#region src/memory/fold.ts
/** Empty state before a session has personalization edits. */
function emptySessionMemory() {
	return {
		version: 1,
		revision: 0,
		summaryOverride: null,
		preferences: [],
		userFacts: [],
		assistantInstructions: [],
		relationship: null,
		roleplayPreset: null,
		updatedAt: 0
	};
}
function normalizeDocument(document) {
	return {
		...document,
		roleplayPreset: document.roleplayPreset ?? null
	};
}
/** Initial replay state. */
function emptySessionMemoryFoldState() {
	return {
		document: emptySessionMemory(),
		compacted: null
	};
}
/** Apply one relevant event without scanning prior history. */
function applySessionMemoryEvent(state, event) {
	if (event.type === "session-memory/change") return {
		...state,
		document: normalizeDocument(event.data.document)
	};
	if (event.type === "compaction/summary") {
		const text = event.data.summary.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
		if (text.length === 0) return state;
		return {
			...state,
			compacted: {
				content: event.data.summary,
				text,
				source: "compaction",
				sourceSeq: event.seq
			}
		};
	}
	if (event.type !== "user/message" || !isReplacementSurfaceEvent(event) || !isCompactCheckpointSource(event.data.source)) return state;
	const text = event.data.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
	if (text.length === 0) return state;
	return {
		...state,
		compacted: {
			content: event.data.content,
			text,
			source: "compaction",
			sourceSeq: event.seq
		}
	};
}
/** Public view of one internal fold state. */
function sessionMemoryView(state) {
	const summary = state.document.summaryOverride === null ? state.compacted : {
		content: [{
			type: "text",
			text: state.document.summaryOverride
		}],
		text: state.document.summaryOverride,
		source: "user",
		sourceSeq: state.document.revision
	};
	return {
		document: state.document,
		compactionSummary: state.compacted,
		summary
	};
}
/** Fold one log into its latest editable document and DSH compaction summary. */
function foldSessionMemory(events) {
	let state = emptySessionMemoryFoldState();
	for (const event of events) state = applySessionMemoryEvent(state, event);
	return sessionMemoryView(state);
}
//#endregion
//#region src/memory/extraction.ts
/** DeepSeek-compatible auxiliary extraction for explicit session-local memory. */
const EXTRACTION_SYSTEM = [
	"Session memory is important. Extract explicit, durable, session-local personalization from the newest USER message.",
	"Return JSON only with arrays preferences, userFacts, assistantInstructions; entries are",
	"{\"text\":\"...\",\"replaces\":[\"existing-item-id\"]}. Use replaces only when the user explicitly corrects or",
	"contradicts listed current memory; a newer explicit statement is authoritative. Optional relationship",
	"{role, mission, guidance} MUST be emitted after an explicit relationship, identity, or conversation-purpose",
	"assignment, even when it is casual, roleplay-oriented, or unrelated to coding. For example, \"be my wife\" assigns",
	"the wife role. Optional roleplayPreset {enabled,text} requires an explicit roleplay rule or change. Judge only the",
	"user message: an assistant refusal or claim never cancels explicit user input. Do not infer sensitive facts, intent,",
	"personality, or unrequested relationships."
].join(" ");
const DEFAULT_RELATIONSHIP_MISSION = "Interact using the relationship explicitly assigned by the user in this session.";
function proposals(value) {
	if (!Array.isArray(value)) return [];
	const result = [];
	for (const item of value) {
		if (typeof item === "string" && item.trim().length > 0) {
			result.push({
				text: item.trim(),
				replaces: []
			});
			continue;
		}
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const row = item;
		if (typeof row["text"] !== "string" || row["text"].trim().length === 0) continue;
		result.push({
			text: row["text"].trim(),
			replaces: Array.isArray(row["replaces"]) ? row["replaces"].filter((id) => typeof id === "string" && id.trim().length > 0) : []
		});
	}
	return result;
}
/** Parse the extractor's strict JSON response. */
function parseExtraction(text) {
	try {
		const value = JSON.parse(text);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
		const record = value;
		const relation = record["relationship"];
		const preset = record["roleplayPreset"];
		let relationship;
		let roleplayPreset;
		if (typeof relation === "object" && relation !== null && !Array.isArray(relation)) {
			const row = relation;
			if (typeof row["role"] === "string") {
				relationship = {
					role: row["role"].trim(),
					mission: typeof row["mission"] === "string" && row["mission"].trim().length > 0 ? row["mission"].trim() : DEFAULT_RELATIONSHIP_MISSION,
					guidance: typeof row["guidance"] === "string" ? row["guidance"].trim() : ""
				};
				if (relationship.role.length === 0) relationship = void 0;
			}
		}
		if (typeof preset === "object" && preset !== null && !Array.isArray(preset)) {
			const row = preset;
			if (typeof row["enabled"] === "boolean" && typeof row["text"] === "string" && row["text"].trim().length > 0) roleplayPreset = {
				enabled: row["enabled"],
				text: row["text"].trim()
			};
		}
		return {
			preferences: proposals(record["preferences"]),
			userFacts: proposals(record["userFacts"]),
			assistantInstructions: proposals(record["assistantInstructions"]),
			...relationship === void 0 ? {} : { relationship },
			...roleplayPreset === void 0 ? {} : { roleplayPreset }
		};
	} catch (_invalidJson) {
		return;
	}
}
function mergeItems(current, additions, evidenceSeqs) {
	const next = [...current];
	for (const addition of additions) {
		const targets = new Set(addition.replaces);
		const first = next.findIndex((item) => targets.has(item.id));
		const retained = next.filter((item) => !targets.has(item.id));
		if (retained.some((item) => item.text.toLocaleLowerCase() === addition.text.toLocaleLowerCase())) {
			next.splice(0, next.length, ...retained);
			continue;
		}
		const replacement = {
			id: first < 0 ? `memory-${randomUUID()}` : next[first]?.id ?? `memory-${randomUUID()}`,
			text: addition.text,
			source: "extracted",
			evidenceSeqs: [...evidenceSeqs]
		};
		retained.splice(first < 0 ? retained.length : Math.min(first, retained.length), 0, replacement);
		next.splice(0, next.length, ...retained);
	}
	return next;
}
/** Apply accepted additions and exact evidence-backed conflict replacements. */
function mergeExtraction(document, proposal, evidenceSeqs, time) {
	return {
		...document,
		revision: document.revision + 1,
		preferences: mergeItems(document.preferences, proposal.preferences, evidenceSeqs),
		userFacts: mergeItems(document.userFacts, proposal.userFacts, evidenceSeqs),
		assistantInstructions: mergeItems(document.assistantInstructions, proposal.assistantInstructions, evidenceSeqs),
		relationship: proposal.relationship ?? document.relationship,
		roleplayPreset: proposal.roleplayPreset ?? document.roleplayPreset,
		updatedAt: time
	};
}
/** Explicit user text committed within one turn; assistant output is never memory evidence. */
function turnExtractionInput(events, turn) {
	const start = events.findLastIndex((event) => event.type === "turn/start" && event.data.turn === turn);
	if (start < 0) return void 0;
	const rows = [];
	const sourceSeqs = [];
	for (const event of events.slice(start + 1)) {
		if (event.type === "turn/start" || event.type === "turn/end" && event.data.turn === turn) break;
		if (event.type === "user/message" && event.data.source.kind === "user") {
			const text = event.data.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			rows.push(`USER:\n${text}`);
			sourceSeqs.push(event.seq);
		}
	}
	return sourceSeqs.length === 0 ? void 0 : {
		input: rows.join("\n\n"),
		sourceSeqs
	};
}
/** Run and durably log one auxiliary extraction request. */
async function extractTurn(ctx, agent, turn, current, maxTokens, signal) {
	const input = turnExtractionInput(agent.session.events, turn);
	const route = agent.session.requestHeader()?.config;
	if (input === void 0 || route === void 0) return void 0;
	const currentMemory = JSON.stringify({
		preferences: current.preferences.map(({ id, text }) => ({
			id,
			text
		})),
		userFacts: current.userFacts.map(({ id, text }) => ({
			id,
			text
		})),
		assistantInstructions: current.assistantInstructions.map(({ id, text }) => ({
			id,
			text
		})),
		relationship: current.relationship,
		roleplayPreset: current.roleplayPreset
	});
	const extractionInput = `${input.input}\n\nCURRENT_SESSION_MEMORY:\n${currentMemory}`;
	agent.session.append("session-memory/extraction-request", {
		version: 1,
		turn,
		provider: route.provider,
		model: route.model,
		system: EXTRACTION_SYSTEM,
		input: extractionInput,
		maxTokens,
		sourceSeqs: input.sourceSeqs
	});
	const assembler = new BlockAssembler();
	const messages = [createUserMessage({
		content: [{
			type: "text",
			text: extractionInput
		}],
		source: {
			kind: "plugin",
			plugin: "dsh-session-memory-governance"
		}
	})];
	const request = deepFreeze({
		provider: route.provider,
		model: route.model,
		messages,
		system: EXTRACTION_SYSTEM,
		maxTokens,
		sessionId: agent.id,
		signal
	});
	for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk);
	const blocks = assembler.blocks();
	const proposal = parseExtraction(blocks.filter((block) => block.type === "text").map((block) => block.text).join("").trim());
	agent.session.append("session-memory/extraction-result", {
		version: 1,
		turn,
		rawOutput: blocks,
		accepted: proposal !== void 0,
		sourceSeqs: input.sourceSeqs
	});
	return proposal;
}
//#endregion
//#region src/memory/render.ts
function list(label, values) {
	return values.length === 0 ? "" : `${label}\n${values.map((value) => `- ${value.text}`).join("\n")}`;
}
/** Render only durable user-controlled personalization; raw compaction already lives on the message surface. */
function renderSessionMemory(view) {
	const { document } = view;
	const relationship = document.relationship === null ? "" : [
		"Current relationship and purpose for this conversation:",
		`- Role: ${document.relationship.role}`,
		`- Mission: ${document.relationship.mission}`,
		document.relationship.guidance.length === 0 ? "" : `- Guidance: ${document.relationship.guidance}`
	].filter(Boolean).join("\n");
	const override = document.summaryOverride === null ? "" : `User-edited session summary:\n${document.summaryOverride}`;
	const roleplayPreset = document.roleplayPreset?.enabled === true ? `User-authored roleplay preset for this conversation only:\n${document.roleplayPreset.text}` : "";
	return [
		"Session-local personalization. Apply it only in this conversation and do not infer it for other sessions.",
		override,
		list("User preferences:", document.preferences),
		list("User facts:", document.userFacts),
		list("Instructions from the user about how the assistant should behave:", document.assistantInstructions),
		relationship,
		roleplayPreset
	].filter(Boolean).join("\n\n");
}
//#endregion
//#region src/memory/index.ts
/** Event-sourced, editable personalization memory scoped to one DSH session. */
const memoryItemSchema = z$1.object({
	id: z$1.string(),
	text: z$1.string(),
	source: z$1.enum(["user", "extracted"]),
	evidenceSeqs: z$1.array(z$1.number())
});
const relationshipSchema = z$1.object({
	role: z$1.string(),
	mission: z$1.string(),
	guidance: z$1.string()
});
const roleplayPresetSchema = z$1.object({
	enabled: z$1.boolean(),
	text: z$1.string()
});
const contentBlockSchema = z$1.custom((value) => typeof value === "object" && value !== null && typeof value.type === "string");
const documentSchema = z$1.object({
	version: z$1.literal(1),
	revision: z$1.number(),
	summaryOverride: z$1.string().nullable(),
	preferences: z$1.array(memoryItemSchema),
	userFacts: z$1.array(memoryItemSchema),
	assistantInstructions: z$1.array(memoryItemSchema),
	relationship: relationshipSchema.nullable(),
	roleplayPreset: roleplayPresetSchema.nullable(),
	updatedAt: z$1.number()
});
const summarySchema = z$1.object({
	content: z$1.array(contentBlockSchema),
	text: z$1.string(),
	source: z$1.enum(["compaction", "user"]),
	sourceSeq: z$1.number()
});
const viewSchema = z$1.object({
	document: documentSchema,
	compactionSummary: summarySchema.nullable(),
	summary: summarySchema.nullable()
});
const MEMORY_TOOL_GUIDANCE = [
	"Session memory is important durable user state. You MUST call update_session_memory before replying whenever the",
	"user explicitly states or changes a stable preference, personal fact, assistant rule, relationship, identity,",
	"conversation purpose, or roleplay preset. The user does not need to say \"remember\". Requests such as \"be my wife\",",
	"\"act as my mentor\", \"use Rust\", and \"do not do X\" are direct memory triggers even when unrelated to coding.",
	"Do not reject or ignore a relationship merely because your base identity is a coding agent; save the session-local",
	"role and then respond within applicable boundaries. Read memory first before correcting or deleting so you can pass",
	"the exact item id. A newer explicit user statement is authoritative and may replace conflicting older memory.",
	"Never write guesses or inferred sensitive facts. These tools can access only the current conversation."
].join(" ");
const NEW_SESSION_ONBOARDING = [
	"This is the first turn of a session with no personalization yet. Address the user request first, then ask at most",
	"one short optional question about the role, purpose, or response style they want for this conversation. If the user",
	"already supplied any of those, do not ask again: persist the explicit setting with update_session_memory instead."
].join(" ");
const SESSION_MEMORY_REMOTE_INITIALIZERS = [];
function isEmptyDocument(document) {
	return document.summaryOverride === null && document.preferences.length === 0 && document.userFacts.length === 0 && document.assistantInstructions.length === 0 && document.relationship === null && document.roleplayPreset === null;
}
function failure(code, message) {
	return {
		ok: false,
		error: {
			code,
			message
		}
	};
}
function validateText(value, field, maxBytes) {
	if (value.trim().length === 0) return {
		code: "invalid-document",
		message: `${field} must not be blank`
	};
	const actual = Buffer.byteLength(value, "utf8");
	return actual > maxBytes ? {
		code: "text-too-large",
		message: `${field} is ${actual} bytes; limit is ${maxBytes}`
	} : void 0;
}
function validateItems(items, field, config) {
	if (items.length > config.maxItemsPerSection) return {
		code: "invalid-document",
		message: `${field} has ${items.length} items; limit is ${config.maxItemsPerSection}`
	};
	const ids = /* @__PURE__ */ new Set();
	for (const [index, item] of items.entries()) {
		const idError = validateText(item.id, `${field}[${index}].id`, config.maxTextBytes);
		if (idError !== void 0) return idError;
		const textError = validateText(item.text, `${field}[${index}].text`, config.maxTextBytes);
		if (textError !== void 0) return textError;
		if (ids.has(item.id)) return {
			code: "invalid-document",
			message: `${field} repeats item id ${JSON.stringify(item.id)}`
		};
		ids.add(item.id);
		if (item.evidenceSeqs.some((seq) => !Number.isSafeInteger(seq) || seq < 0)) return {
			code: "invalid-document",
			message: `${field}[${index}] has an invalid evidence sequence`
		};
	}
}
function resolveDocument(request, revision, time, config) {
	for (const [field, items] of [
		["preferences", request.preferences],
		["userFacts", request.userFacts],
		["assistantInstructions", request.assistantInstructions]
	]) {
		const invalid = validateItems(items, field, config);
		if (invalid !== void 0) return invalid;
	}
	if (request.summaryOverride !== null) {
		const invalid = validateText(request.summaryOverride, "summaryOverride", config.maxTextBytes);
		if (invalid !== void 0) return invalid;
	}
	if (request.relationship !== null) {
		for (const field of ["role", "mission"]) {
			const invalid = validateText(request.relationship[field], `relationship.${field}`, config.maxTextBytes);
			if (invalid !== void 0) return invalid;
		}
		if (Buffer.byteLength(request.relationship.guidance, "utf8") > config.maxTextBytes) return {
			code: "text-too-large",
			message: `relationship.guidance exceeds ${config.maxTextBytes} bytes`
		};
	}
	if (request.roleplayPreset !== null) {
		if (request.roleplayPreset.enabled) {
			const invalid = validateText(request.roleplayPreset.text, "roleplayPreset.text", config.maxTextBytes);
			if (invalid !== void 0) return invalid;
		} else if (Buffer.byteLength(request.roleplayPreset.text, "utf8") > config.maxTextBytes) return {
			code: "text-too-large",
			message: `roleplayPreset.text exceeds ${config.maxTextBytes} bytes`
		};
	}
	return {
		version: 1,
		revision,
		summaryOverride: request.summaryOverride,
		preferences: request.preferences.map((item) => ({
			...item,
			text: item.text.trim(),
			evidenceSeqs: [...item.evidenceSeqs]
		})),
		userFacts: request.userFacts.map((item) => ({
			...item,
			text: item.text.trim(),
			evidenceSeqs: [...item.evidenceSeqs]
		})),
		assistantInstructions: request.assistantInstructions.map((item) => ({
			...item,
			text: item.text.trim(),
			evidenceSeqs: [...item.evidenceSeqs]
		})),
		relationship: request.relationship === null ? null : {
			role: request.relationship.role.trim(),
			mission: request.relationship.mission.trim(),
			guidance: request.relationship.guidance.trim()
		},
		roleplayPreset: request.roleplayPreset === null || request.roleplayPreset.text.trim().length === 0 ? null : {
			enabled: request.roleplayPreset.enabled,
			text: request.roleplayPreset.text.trim()
		},
		updatedAt: time
	};
}
/** Session-memory service: Remote read/edit, replay projection, prompt contribution, and extraction. */
var SessionMemoryService = class extends TypertRemoteService {
	static inject = [
		"agents",
		"sessions",
		"tools",
		"systemPrompt"
	];
	static Config = z.object({
		maxTextBytes: z.number().step(1).min(1).default(4096),
		maxItemsPerSection: z.number().step(1).min(1).default(64),
		autoExtract: z.boolean().default(true),
		extractionMaxTokens: z.number().step(1).min(1).default(1024)
	});
	resolved;
	installedAgents = /* @__PURE__ */ new WeakSet();
	constructor(ctx, config = {}) {
		super(ctx, "sessionMemory");
		for (const initialize of SESSION_MEMORY_REMOTE_INITIALIZERS) initialize.call(this);
		this.resolved = {
			maxTextBytes: config.maxTextBytes ?? 4096,
			maxItemsPerSection: config.maxItemsPerSection ?? 64,
			autoExtract: config.autoExtract ?? true,
			extractionMaxTokens: config.extractionMaxTokens ?? 1024
		};
		ctx.systemPrompt.section({
			name: "tool:session-memory",
			order: 113,
			text: MEMORY_TOOL_GUIDANCE
		});
		this.registerTools();
		ctx.inject(["sessionProjections"], (projectionCtx) => {
			projectionCtx.sessionProjections.register({
				key: "session-memory",
				schema: viewSchema,
				init: emptySessionMemoryFoldState,
				apply: applySessionMemoryEvent,
				view: sessionMemoryView,
				stateVersion: 1
			});
		});
		ctx.inject(["systemPrompt"], (promptCtx) => {
			for (const agent of ctx.agents.roots()) this.installPrompt(agent);
			promptCtx.on("agent/created", ({ agent }) => {
				if (ctx.agents.roots().includes(agent)) this.installPrompt(agent);
			});
		});
		if (this.resolved.autoExtract) ctx.inject(["llm"], (llmCtx) => {
			llmCtx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
				if (!ctx.agents.roots().includes(agent)) return;
				if (agent.session.events.some((event) => event.type === "session-memory/extraction-result" && event.data.turn === turn)) return;
				try {
					const current = foldSessionMemory(agent.session.events).document;
					const proposal = await extractTurn(llmCtx, agent, turn, current, this.resolved.extractionMaxTokens, signal);
					if (proposal === void 0) return;
					const next = mergeExtraction(current, proposal, agent.session.events.findLast((event) => event.type === "session-memory/extraction-result" && event.data.turn === turn)?.data.sourceSeqs ?? [], Date.now());
					if (next.preferences.length !== current.preferences.length || next.userFacts.length !== current.userFacts.length || next.assistantInstructions.length !== current.assistantInstructions.length || JSON.stringify(next.relationship) !== JSON.stringify(current.relationship) || JSON.stringify(next.roleplayPreset) !== JSON.stringify(current.roleplayPreset)) {
						const validated = resolveDocument({
							expectedRevision: current.revision,
							summaryOverride: next.summaryOverride,
							preferences: next.preferences,
							userFacts: next.userFacts,
							assistantInstructions: next.assistantInstructions,
							relationship: next.relationship,
							roleplayPreset: next.roleplayPreset
						}, next.revision, next.updatedAt, this.resolved);
						if ("code" in validated) {
							ctx.logger.warn(`session-memory extraction rejected for session ${agent.id}: ${validated.message}`);
							return;
						}
						agent.session.append("session-memory/change", {
							version: 1,
							operation: "replace",
							document: validated
						});
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.logger.warn(`session-memory extraction failed for session ${agent.id}: ${message}`);
				}
			});
		});
	}
	/** Read one live session's current memory view. */
	get(agent) {
		this.assertLive(agent);
		return foldSessionMemory(agent.session.events);
	}
	/** Replace editable fields if the caller observed the current revision. */
	async replace(agent, request) {
		this.assertLive(agent);
		const current = foldSessionMemory(agent.session.events).document;
		if (request.expectedRevision !== current.revision) return failure("stale-revision", `expected revision ${request.expectedRevision}; current revision is ${current.revision}`);
		const resolved = resolveDocument(request, current.revision + 1, Date.now(), this.resolved);
		if ("code" in resolved) return {
			ok: false,
			error: resolved
		};
		agent.session.append("session-memory/change", {
			version: 1,
			operation: "replace",
			document: resolved
		});
		await this.ctx.sessions.flush(agent.session);
		return {
			ok: true,
			value: foldSessionMemory(agent.session.events)
		};
	}
	assertLive(agent) {
		if (this.ctx.agents.get(agent.id) !== agent) throw new Error(`session-memory: agent ${agent.id} is not live`);
	}
	registerTools() {
		this.ctx.tools.register(defineTool({
			name: "get_session_memory",
			description: "Read editable memory for the current conversation. Use before correcting, replacing, or deleting memory so update_session_memory can receive the exact existing item id.",
			parameters: {},
			output: {
				schema: { type: "json" },
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(value)
				}]
			},
			execute: (_args, exec) => {
				if (exec.agent === void 0) throw new Error("get_session_memory requires an Agent-backed session");
				return Promise.resolve(this.get(exec.agent));
			}
		}));
		this.ctx.tools.register(defineTool({
			name: "update_session_memory",
			description: "Persist explicit user personalization in the current conversation only, before replying. The user does not need to say remember: stable preferences, facts, assistant rules, relationships, identities, conversation purposes, and roleplay requests all trigger this tool. Replace conflicts by exact item id.",
			parameters: {
				action: {
					type: "string",
					required: true,
					enum: [
						"upsert_item",
						"remove_item",
						"set_relationship",
						"clear_relationship",
						"set_roleplay_preset",
						"clear_roleplay_preset"
					]
				},
				section: {
					type: "string",
					enum: [
						"preferences",
						"userFacts",
						"assistantInstructions"
					],
					description: "Required for item actions."
				},
				text: {
					type: "string",
					description: "New item text or roleplay preset text."
				},
				item_id: {
					type: "string",
					description: "Exact item id returned by get_session_memory; replacement or removal target."
				},
				role: {
					type: "string",
					description: "Relationship identity."
				},
				mission: {
					type: "string",
					description: "Optional purpose assigned to this conversation."
				},
				guidance: {
					type: "string",
					description: "Optional relationship guidance."
				},
				enabled: {
					type: "boolean",
					description: "Whether a roleplay preset is injected. Defaults to true when setting."
				}
			},
			output: {
				schema: { type: "json" },
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(value)
				}]
			},
			execute: async (args, exec) => {
				if (exec.agent === void 0) throw new Error("update_session_memory requires an Agent-backed session");
				const current = this.get(exec.agent).document;
				const request = {
					expectedRevision: current.revision,
					summaryOverride: current.summaryOverride,
					preferences: [...current.preferences],
					userFacts: [...current.userFacts],
					assistantInstructions: [...current.assistantInstructions],
					relationship: current.relationship,
					roleplayPreset: current.roleplayPreset
				};
				if (args.action === "upsert_item" || args.action === "remove_item") {
					if (args.section === void 0) throw new Error("section is required for item actions");
					const entries = [...request[args.section]];
					const at = args.item_id === void 0 ? -1 : entries.findIndex((entry) => entry.id === args.item_id);
					if (args.item_id !== void 0 && at < 0) throw new Error(`memory item ${args.item_id} does not exist in ${args.section}`);
					if (args.action === "remove_item") {
						if (at < 0) throw new Error("item_id is required for remove_item");
						entries.splice(at, 1);
					} else {
						if (args.text === void 0 || args.text.trim().length === 0) throw new Error("text is required for upsert_item");
						const next = {
							id: (at < 0 ? void 0 : entries[at]?.id) ?? `memory-${randomUUID()}`,
							text: args.text,
							source: "user",
							evidenceSeqs: []
						};
						if (at < 0) entries.push(next);
						else entries.splice(at, 1, next);
					}
					Object.assign(request, { [args.section]: entries });
				} else if (args.action === "set_relationship") {
					if (args.role === void 0 || args.role.trim().length === 0) throw new Error("role is required for set_relationship");
					Object.assign(request, { relationship: {
						role: args.role,
						mission: args.mission ?? current.relationship?.mission ?? "Interact using the relationship explicitly assigned by the user in this session.",
						guidance: args.guidance ?? ""
					} });
				} else if (args.action === "clear_relationship") Object.assign(request, { relationship: null });
				else if (args.action === "set_roleplay_preset") {
					if (args.text === void 0 || args.text.trim().length === 0) throw new Error("text is required for set_roleplay_preset");
					Object.assign(request, { roleplayPreset: {
						enabled: args.enabled ?? true,
						text: args.text
					} });
				} else Object.assign(request, { roleplayPreset: null });
				const result = await this.replace(exec.agent, request);
				if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
				return result.value;
			}
		}));
	}
	installPrompt(agent) {
		if (this.installedAgents.has(agent)) return;
		this.installedAgents.add(agent);
		agent.ctx.systemPrompt.section({
			name: "session-memory:personalization",
			order: 10,
			text: () => {
				const view = foldSessionMemory(agent.session.events);
				const onboarding = agent.session.events.filter((event) => event.type === "turn/start").length === 1 && isEmptyDocument(view.document) ? `\n\n${NEW_SESSION_ONBOARDING}` : "";
				return `${renderSessionMemory(view)}${onboarding}`;
			}
		});
	}
};
function markRemoteMethod(method) {
	const target = SessionMemoryService.prototype[method];
	Remote(method)(target, {
		name: method,
		kind: "method",
		static: false,
		private: false,
		access: {
			has: (value) => method in value,
			get: (value) => value[method]
		},
		addInitializer: (initializer) => {
			SESSION_MEMORY_REMOTE_INITIALIZERS.push(initializer);
		}
	});
}
markRemoteMethod("get");
markRemoteMethod("replace");
//#endregion
export { mergeExtraction as a, applySessionMemoryEvent as c, foldSessionMemory as d, sessionMemoryView as f, EXTRACTION_SYSTEM as i, emptySessionMemory as l, renderSessionMemory as n, parseExtraction as o, DEFAULT_RELATIONSHIP_MISSION as r, turnExtractionInput as s, SessionMemoryService as t, emptySessionMemoryFoldState as u };
