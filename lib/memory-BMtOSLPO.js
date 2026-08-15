import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
//#region src/memory/fold.ts
/** Empty state before a session has personalization edits. */
function emptySessionMemory() {
	return {
		version: 2,
		revision: 0,
		userProfile: {
			confirmed: "",
			inferred: "",
			evidenceSeqs: []
		},
		preferences: [],
		assistantInstructions: [],
		relationship: null,
		roleplayPreset: null,
		updatedAt: 0
	};
}
function legacyCard(item, category) {
	return {
		...item,
		category,
		evidenceSeqs: [...item.evidenceSeqs]
	};
}
function mergeCardText(current, incoming) {
	const left = current.trim();
	const right = incoming.trim();
	if (left.length === 0) return right;
	if (right.length === 0 || left.includes(right)) return left;
	if (right.includes(left)) return right;
	return `${left}；${right}`;
}
/** Repair historical duplicate categories deterministically before any new mutation is validated. */
function normalizeMemoryCards(items, fallbackCategory) {
	const result = [];
	const categoryIndexes = /* @__PURE__ */ new Map();
	for (const [index, item] of items.entries()) {
		const category = item.category.trim() || fallbackCategory;
		const text = item.text.trim();
		if (text.length === 0) continue;
		const key = category.toLocaleLowerCase();
		const duplicateAt = categoryIndexes.get(key);
		if (duplicateAt !== void 0) {
			const current = result[duplicateAt];
			result[duplicateAt] = {
				...current,
				text: mergeCardText(current.text, text),
				source: current.source === "user" || item.source === "user" ? "user" : "extracted",
				evidenceSeqs: [.../* @__PURE__ */ new Set([...current.evidenceSeqs, ...item.evidenceSeqs])]
			};
			continue;
		}
		categoryIndexes.set(key, result.length);
		result.push({
			...item,
			id: item.id.trim() || `replayed-${fallbackCategory}-${index}`,
			category,
			text,
			evidenceSeqs: [...new Set(item.evidenceSeqs)]
		});
	}
	while (result.length > 3) {
		const overflow = result.pop();
		const target = result[2];
		result[2] = {
			...target,
			category: `${target.category} / ${overflow.category}`,
			text: mergeCardText(target.text, `${overflow.category}：${overflow.text}`),
			source: target.source === "user" || overflow.source === "user" ? "user" : "extracted",
			evidenceSeqs: [.../* @__PURE__ */ new Set([...target.evidenceSeqs, ...overflow.evidenceSeqs])]
		};
	}
	return result;
}
/** Normalize persisted V2 documents so early preview builds cannot lock all later writes. */
function normalizeSessionMemoryDocument(document) {
	return {
		...document,
		userProfile: {
			confirmed: document.userProfile.confirmed.trim(),
			inferred: document.userProfile.inferred.trim(),
			evidenceSeqs: [...new Set(document.userProfile.evidenceSeqs)]
		},
		preferences: normalizeMemoryCards(document.preferences, "综合偏好"),
		assistantInstructions: normalizeMemoryCards(document.assistantInstructions, "交互要求")
	};
}
function migrateLegacyCards(items, category) {
	return normalizeMemoryCards(items.map((item) => legacyCard(item, category)), category);
}
/** Lossless-enough migration of the editable v0.1 state. Compaction overrides are deliberately retired. */
function migrateLegacyDocument(document) {
	const facts = document.userFacts.map((item) => item.text.trim()).filter(Boolean);
	const factEvidence = document.userFacts.flatMap((item) => item.evidenceSeqs);
	return {
		version: 2,
		revision: document.revision,
		userProfile: {
			confirmed: facts.join("；"),
			inferred: "",
			evidenceSeqs: [...new Set(factEvidence)]
		},
		preferences: migrateLegacyCards(document.preferences, "综合偏好"),
		assistantInstructions: migrateLegacyCards(document.assistantInstructions, "交互要求"),
		relationship: document.relationship,
		roleplayPreset: document.roleplayPreset ?? null,
		updatedAt: document.updatedAt
	};
}
/** Initial replay state. */
function emptySessionMemoryFoldState() {
	return {
		document: emptySessionMemory(),
		memoryActivity: []
	};
}
/** Apply one relevant event without scanning prior history. */
function applySessionMemoryEvent(state, event) {
	if (event.type !== "session-memory/change") return state;
	if (event.data.version === 1) return {
		...state,
		document: migrateLegacyDocument(event.data.document)
	};
	return {
		document: normalizeSessionMemoryDocument(event.data.document),
		memoryActivity: [...state.memoryActivity, ...event.data.changes]
	};
}
/** Public view of one internal fold state. */
function sessionMemoryView(state) {
	return {
		document: state.document,
		memoryActivity: state.memoryActivity
	};
}
/** Fold one log into its latest editable document and activity ledger. */
function foldSessionMemory(events) {
	let state = emptySessionMemoryFoldState();
	for (const event of events) state = applySessionMemoryEvent(state, event);
	return sessionMemoryView(state);
}
//#endregion
//#region src/memory/extraction.ts
/** DeepSeek-compatible auxiliary extraction and whole-state memory consolidation. */
const MAX_MEMORY_CARDS = 3;
const DEFAULT_PROFILE_CHARACTERS = 300;
const EXTRACTION_SYSTEM = [
	"Session memory is important. Consolidate durable session-local personalization from the newest USER message into",
	"the COMPLETE current memory state. Return JSON only with keys userProfile, preferences, assistantInstructions,",
	"relationship, roleplayPreset. userProfile is {confirmed,inferred}: confirmed contains only user-stated identity,",
	"demographics, location, work, skills, life state, and durable habits; inferred contains cautious non-sensitive",
	"observations and must never be presented as fact. Keep their combined text near or below 300 Chinese characters.",
	"preferences and assistantInstructions are complete arrays of at most 3 {category,text} cards. A card is a compact",
	"structured category containing all related details. Merge new details into the best existing card; do not append a",
	"sentence-shaped card when a category can absorb it. A newer explicit correction replaces conflicting old content.",
	"For “not X but Y” corrections, remove X instead of preserving “does not use X” unless the user separately states",
	"that avoiding X is itself a durable preference.",
	"Preserve every unaffected current fact and card. relationship and roleplayPreset are the complete resulting object",
	"or null. An assistant name, nickname, self-designation, relationship-specific title, or how the user addresses the",
	"assistant belongs in relationship or roleplayPreset, never userProfile or preferences. Preserve existing preset",
	"content when adding an alias. Judge only user text: assistant refusal does not cancel user input. Never invent",
	"sensitive facts. The",
	"response is rejected atomically if incomplete or invalid. Also return atoms, one row for EVERY distinct claim in",
	"the newest user message: {text,disposition:\"handled\"|\"skipped\",section,reason}; handled requires a target section",
	"and skipped requires a concrete reason. This coverage ledger prevents partial writes."
].join(" ");
const DEFAULT_RELATIONSHIP_MISSION = "Interact using the relationship explicitly assigned by the user in this session.";
/** Add an assistant identity note without silently changing the user's preset switch. */
function mergeAssistantIdentity(current, identity, enabled) {
	const note = identity.trim();
	const existing = current?.text.trim() ?? "";
	const text = existing.includes(note) ? existing : [existing, note].filter(Boolean).join("\n");
	return {
		enabled: enabled ?? current?.enabled ?? true,
		text
	};
}
function clean(value) {
	return typeof value === "string" ? value.trim() : void 0;
}
function parseCards(value) {
	if (!Array.isArray(value) || value.length > 16) return void 0;
	const cards = [];
	const categories = /* @__PURE__ */ new Set();
	for (const item of value) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return void 0;
		const row = item;
		const category = clean(row["category"]);
		const text = clean(row["text"]);
		if (category === void 0 || category.length === 0 || text === void 0 || text.length === 0) return void 0;
		const key = category.toLocaleLowerCase();
		if (categories.has(key)) return void 0;
		categories.add(key);
		cards.push({
			category,
			text
		});
	}
	return cards;
}
const SECTIONS = /* @__PURE__ */ new Set([
	"userProfile",
	"preferences",
	"assistantInstructions",
	"relationship",
	"roleplayPreset"
]);
function parseAtoms(value) {
	if (!Array.isArray(value) || value.length === 0 || value.length > 64) return void 0;
	const atoms = [];
	for (const valueItem of value) {
		if (typeof valueItem !== "object" || valueItem === null || Array.isArray(valueItem)) return void 0;
		const row = valueItem;
		const text = clean(row["text"]);
		const reason = clean(row["reason"]);
		const disposition = row["disposition"];
		const section = row["section"] === null ? null : clean(row["section"]);
		if (text === void 0 || text.length === 0 || reason === void 0 || reason.length === 0) return void 0;
		if (disposition !== "handled" && disposition !== "skipped") return void 0;
		if (section !== null && !SECTIONS.has(section)) return void 0;
		if (disposition === "handled" && section === null) return void 0;
		atoms.push({
			text,
			reason,
			disposition,
			section
		});
	}
	return atoms;
}
function parseRelationship(value) {
	if (value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) return void 0;
	const row = value;
	const role = clean(row["role"]);
	const mission = clean(row["mission"]);
	const guidance = clean(row["guidance"]);
	if (role === void 0 || role.length === 0 || mission === void 0 || mission.length === 0 || guidance === void 0) return;
	return {
		role,
		mission,
		guidance
	};
}
function parseRoleplayPreset(value) {
	if (value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) return void 0;
	const row = value;
	const text = clean(row["text"]);
	if (typeof row["enabled"] !== "boolean" || text === void 0 || text.length === 0) return void 0;
	return {
		enabled: row["enabled"],
		text
	};
}
/** Parse one strict, complete replacement proposal. Partial model output is rejected. */
function parseExtraction(text) {
	try {
		const value = JSON.parse(text);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
		const record = value;
		const profile = record["userProfile"];
		if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return void 0;
		const profileRecord = profile;
		const confirmed = clean(profileRecord["confirmed"]);
		const inferred = clean(profileRecord["inferred"]);
		if (confirmed === void 0 || inferred === void 0) return void 0;
		if ([...`${confirmed}${inferred}`].length > 300) return void 0;
		const preferences = parseCards(record["preferences"]);
		const assistantInstructions = parseCards(record["assistantInstructions"]);
		const relationship = parseRelationship(record["relationship"]);
		const roleplayPreset = parseRoleplayPreset(record["roleplayPreset"]);
		const atoms = parseAtoms(record["atoms"]);
		if (preferences === void 0 || assistantInstructions === void 0 || relationship === void 0 || roleplayPreset === void 0 || atoms === void 0) return void 0;
		return {
			userProfile: {
				confirmed,
				inferred
			},
			preferences,
			assistantInstructions,
			relationship,
			roleplayPreset,
			atoms
		};
	} catch (_invalidJson) {
		return;
	}
}
function normalized(value) {
	return value.trim().toLocaleLowerCase().replaceAll(/\s+/g, " ");
}
function cardText(card) {
	return `${card.category}：${card.text}`;
}
function objectText(value) {
	return value === null ? null : JSON.stringify(value);
}
function operation(before, after) {
	if (before === null) return "append";
	if (after === null) return "replace";
	return normalized(after).includes(normalized(before)) ? "merge" : "replace";
}
function consolidateOverflow(cards) {
	const next = cards.slice(0, 3).map((card) => ({ ...card }));
	for (const overflow of cards.slice(3)) {
		let target = 0;
		for (let index = 1; index < next.length; index += 1) if ((next[index]?.text.length ?? Infinity) < (next[target]?.text.length ?? Infinity)) target = index;
		const current = next[target];
		if (current === void 0) break;
		next[target] = {
			category: `${current.category} / ${overflow.category}`,
			text: `${current.text}；${overflow.category}：${overflow.text}`
		};
	}
	return next;
}
function activity(section, before, after, sourceSeqs, time, reason) {
	return {
		id: `activity-${randomUUID()}`,
		sourceSeqs: [...sourceSeqs],
		operation: operation(before, after),
		section,
		before,
		after,
		reason,
		at: time
	};
}
function reconcileCards(section, current, proposed, evidenceSeqs, time) {
	const available = [...current];
	const items = [];
	const changes = [];
	for (const card of consolidateOverflow(proposed)) {
		const at = available.findIndex((item) => normalized(item.category) === normalized(card.category));
		const previous = at < 0 ? void 0 : available.splice(at, 1)[0];
		const unchanged = previous !== void 0 && normalized(previous.category) === normalized(card.category) && normalized(previous.text) === normalized(card.text);
		const next = unchanged ? previous : {
			id: previous?.id ?? `memory-${randomUUID()}`,
			category: card.category,
			text: card.text,
			source: "extracted",
			evidenceSeqs: [.../* @__PURE__ */ new Set([...previous?.evidenceSeqs ?? [], ...evidenceSeqs])]
		};
		items.push(next);
		if (!unchanged) changes.push(activity(section, previous === void 0 ? null : cardText(previous), cardText(next), evidenceSeqs, time, previous === void 0 ? "Added a durable category from explicit user evidence." : "Consolidated the newest explicit user evidence into its existing category."));
	}
	for (const removed of available) changes.push(activity(section, cardText(removed), null, evidenceSeqs, time, "Removed or superseded while reconciling the complete categorized state."));
	return {
		items,
		changes
	};
}
/** Atomically reconcile one complete proposal against current memory without model-supplied item ids. */
function mergeExtraction(document, proposal, evidenceSeqs, time) {
	const preferences = reconcileCards("preferences", document.preferences, proposal.preferences, evidenceSeqs, time);
	const instructions = reconcileCards("assistantInstructions", document.assistantInstructions, proposal.assistantInstructions, evidenceSeqs, time);
	const changes = [...preferences.changes, ...instructions.changes];
	const profileChanged = normalized(document.userProfile.confirmed) !== normalized(proposal.userProfile.confirmed) || normalized(document.userProfile.inferred) !== normalized(proposal.userProfile.inferred);
	const userProfile = profileChanged ? {
		...proposal.userProfile,
		evidenceSeqs: [.../* @__PURE__ */ new Set([...document.userProfile.evidenceSeqs, ...evidenceSeqs])]
	} : document.userProfile;
	if (profileChanged) {
		const before = document.userProfile.confirmed.length === 0 && document.userProfile.inferred.length === 0 ? null : `已确认：${document.userProfile.confirmed}\n观察：${document.userProfile.inferred}`;
		changes.unshift(activity("userProfile", before, `已确认：${userProfile.confirmed}\n观察：${userProfile.inferred}`, evidenceSeqs, time, "Rewrote the compact profile from the complete current profile and newest user evidence."));
	}
	for (const [section, before, after] of [[
		"relationship",
		document.relationship,
		proposal.relationship
	], [
		"roleplayPreset",
		document.roleplayPreset,
		proposal.roleplayPreset
	]]) if (JSON.stringify(before) !== JSON.stringify(after)) changes.push(activity(section, objectText(before), objectText(after), evidenceSeqs, time, "Applied the newest explicit session assignment over the prior value."));
	const changed = changes.length > 0;
	const changedSections = new Set(changes.map((change) => change.section));
	for (const atom of proposal.atoms) if (atom.disposition === "skipped" || atom.section === null || !changedSections.has(atom.section)) changes.push({
		id: `activity-${randomUUID()}`,
		sourceSeqs: [...evidenceSeqs],
		operation: "skip",
		section: atom.section ?? "userProfile",
		before: null,
		after: null,
		reason: atom.disposition === "skipped" ? atom.reason : `Already represented: ${atom.reason}`,
		at: time
	});
	return {
		document: {
			version: 2,
			revision: changed ? document.revision + 1 : document.revision,
			userProfile,
			preferences: preferences.items,
			assistantInstructions: instructions.items,
			relationship: proposal.relationship,
			roleplayPreset: proposal.roleplayPreset,
			updatedAt: changed ? time : document.updatedAt
		},
		changes
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
	const { BlockAssembler, createUserMessage, deepFreeze } = await import("@deepseek-ai/dsh-llm");
	const input = turnExtractionInput(agent.session.events, turn);
	const route = agent.session.requestHeader()?.config;
	if (input === void 0 || route === void 0) return void 0;
	const extractionInput = `${input.input}\n\nCURRENT_SESSION_MEMORY:\n${JSON.stringify(current)}`;
	agent.session.append("session-memory/extraction-request", {
		version: 2,
		turn,
		provider: route.provider,
		model: route.model,
		system: EXTRACTION_SYSTEM,
		input: extractionInput,
		maxTokens,
		sourceSeqs: input.sourceSeqs
	}, { ignorable: true });
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
		version: 2,
		turn,
		rawOutput: blocks,
		accepted: proposal !== void 0,
		sourceSeqs: input.sourceSeqs
	}, { ignorable: true });
	return proposal;
}
//#endregion
//#region src/memory/render.ts
function cards(label, values) {
	return values.length === 0 ? "" : `${label}\n${values.map((value) => `- ${value.category}: ${value.text}`).join("\n")}`;
}
/** Render only the categorized V2 personalization state; DSH compaction stays on its native message surface. */
function renderSessionMemory(view) {
	const { document } = view;
	const profile = document.userProfile.confirmed.length === 0 && document.userProfile.inferred.length === 0 ? "" : [
		"Compact user profile for this conversation:",
		document.userProfile.confirmed.length === 0 ? "" : `- Confirmed by user: ${document.userProfile.confirmed}`,
		document.userProfile.inferred.length === 0 ? "" : `- Cautious observation, not confirmed fact: ${document.userProfile.inferred}`
	].filter(Boolean).join("\n");
	const relationship = document.relationship === null ? "" : [
		"Current relationship and purpose for this conversation:",
		`- Role: ${document.relationship.role}`,
		`- Mission: ${document.relationship.mission}`,
		document.relationship.guidance.length === 0 ? "" : `- Guidance: ${document.relationship.guidance}`
	].filter(Boolean).join("\n");
	const roleplayPreset = document.roleplayPreset?.enabled === true ? `User-authored roleplay preset for this conversation only:\n${document.roleplayPreset.text}` : "";
	return [
		"Session-local personalization. Apply it only in this conversation and do not infer it for other sessions.",
		profile,
		cards("Categorized user preferences:", document.preferences),
		cards("Categorized instructions from the user about assistant behavior:", document.assistantInstructions),
		relationship,
		roleplayPreset
	].filter(Boolean).join("\n\n");
}
//#endregion
//#region src/memory/index.ts
/** Event-sourced, editable personalization memory scoped to one DSH session. */
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) {
			if (kind === "field") initializers.unshift(_);
			else descriptor[key] = _;
		}
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
const memoryItemSchema = z$1.object({
	id: z$1.string(),
	category: z$1.string(),
	text: z$1.string(),
	source: z$1.enum(["user", "extracted"]),
	evidenceSeqs: z$1.array(z$1.number())
});
const userProfileSchema = z$1.object({
	confirmed: z$1.string(),
	inferred: z$1.string(),
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
const activitySchema = z$1.object({
	id: z$1.string(),
	sourceSeqs: z$1.array(z$1.number()),
	operation: z$1.enum([
		"append",
		"merge",
		"replace",
		"skip"
	]),
	section: z$1.enum([
		"userProfile",
		"preferences",
		"assistantInstructions",
		"relationship",
		"roleplayPreset"
	]),
	before: z$1.string().nullable(),
	after: z$1.string().nullable(),
	reason: z$1.string(),
	at: z$1.number()
});
const documentSchema = z$1.object({
	version: z$1.literal(2),
	revision: z$1.number(),
	userProfile: userProfileSchema,
	preferences: z$1.array(memoryItemSchema),
	assistantInstructions: z$1.array(memoryItemSchema),
	relationship: relationshipSchema.nullable(),
	roleplayPreset: roleplayPresetSchema.nullable(),
	updatedAt: z$1.number()
});
const viewSchema = z$1.object({
	document: documentSchema,
	memoryActivity: z$1.array(activitySchema)
});
const MEMORY_TOOL_GUIDANCE = [
	"Session memory is important durable user state. Call update_session_memory before replying whenever the user",
	"explicitly states or changes stable personal information, a preference, an assistant rule, relationship, identity,",
	"conversation purpose, or roleplay preset. The user does not need to say remember. Merge related preferences and",
	"assistant instructions into categorized cards; each section can contain at most three cards. New explicit facts",
	"replace conflicts. The personal profile separates confirmed user facts from cautious inferred observations.",
	"Taxonomy is strict: userProfile is only identity, demographics, location, work, skills, life state, and durable",
	"traits; preferences is what the user likes, dislikes, chooses, or habitually uses; assistantInstructions is how",
	"the assistant must answer or act. Never put answer-style rules in preferences, and never put likes/dislikes in",
	"userProfile. The assistant persona, name, nickname, self-designation, relationship-specific title, and how the user",
	"addresses the assistant belong in relationship or roleplayPreset, never userProfile or preferences. Use",
	"remember_assistant_identity for an additive assistant nickname or identity note. One message may require several",
	"update_session_memory calls so every section is updated.",
	"Never store an inference as confirmed or infer sensitive data. These tools affect only the current conversation."
].join(" ");
const NEW_SESSION_ONBOARDING = [
	"This is the first turn of a session with no personalization yet. Address the user request first, then ask at most",
	"one short optional question about the role, purpose, or response style they want for this conversation. If the user",
	"already supplied any of those, do not ask again: persist the explicit setting with update_session_memory instead."
].join(" ");
function isEmptyDocument(document) {
	return document.userProfile.confirmed.length === 0 && document.userProfile.inferred.length === 0 && document.preferences.length === 0 && document.assistantInstructions.length === 0 && document.relationship === null && document.roleplayPreset === null;
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
		message: `${field} has ${items.length} cards; limit is ${config.maxItemsPerSection}`
	};
	const ids = /* @__PURE__ */ new Set();
	const categories = /* @__PURE__ */ new Set();
	for (const [index, item] of items.entries()) {
		for (const [name, value] of [
			["id", item.id],
			["category", item.category],
			["text", item.text]
		]) {
			const invalid = validateText(value, `${field}[${index}].${name}`, config.maxTextBytes);
			if (invalid !== void 0) return invalid;
		}
		if (ids.has(item.id)) return {
			code: "invalid-document",
			message: `${field} repeats item id ${JSON.stringify(item.id)}`
		};
		ids.add(item.id);
		const category = item.category.trim().toLocaleLowerCase();
		if (categories.has(category)) return {
			code: "invalid-document",
			message: `${field} repeats category ${JSON.stringify(item.category)}`
		};
		categories.add(category);
		if (item.evidenceSeqs.some((seq) => !Number.isSafeInteger(seq) || seq < 0)) return {
			code: "invalid-document",
			message: `${field}[${index}] has an invalid evidence sequence`
		};
	}
}
function resolveDocument(request, revision, time, config) {
	for (const [field, items] of [["preferences", request.preferences], ["assistantInstructions", request.assistantInstructions]]) {
		const invalid = validateItems(items, field, config);
		if (invalid !== void 0) return invalid;
	}
	const profileCharacters = [...`${request.userProfile.confirmed}${request.userProfile.inferred}`].length;
	if (profileCharacters > config.maxProfileCharacters) return {
		code: "text-too-large",
		message: `userProfile is ${profileCharacters} characters; limit is ${config.maxProfileCharacters}`
	};
	for (const [field, value] of [["userProfile.confirmed", request.userProfile.confirmed], ["userProfile.inferred", request.userProfile.inferred]]) if (Buffer.byteLength(value, "utf8") > config.maxTextBytes) return {
		code: "text-too-large",
		message: `${field} exceeds ${config.maxTextBytes} bytes`
	};
	if (request.userProfile.evidenceSeqs.some((seq) => !Number.isSafeInteger(seq) || seq < 0)) return {
		code: "invalid-document",
		message: "userProfile has an invalid evidence sequence"
	};
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
		version: 2,
		revision,
		userProfile: {
			confirmed: request.userProfile.confirmed.trim().replace(/^(?:已确认|确认信息)[:：]\s*/u, ""),
			inferred: request.userProfile.inferred.trim().replace(/^(?:AI\s*观察|观察)[:：]\s*/iu, ""),
			evidenceSeqs: [...request.userProfile.evidenceSeqs]
		},
		preferences: request.preferences.map((item) => ({
			...item,
			category: item.category.trim(),
			text: item.text.trim(),
			evidenceSeqs: [...item.evidenceSeqs]
		})),
		assistantInstructions: request.assistantInstructions.map((item) => ({
			...item,
			category: item.category.trim(),
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
function displayProfile(document) {
	const { confirmed, inferred } = document.userProfile;
	return confirmed.length === 0 && inferred.length === 0 ? null : `已确认：${confirmed}\n观察：${inferred}`;
}
function makeActivity(section, before, after, time, sourceSeqs) {
	return {
		id: `activity-${randomUUID()}`,
		sourceSeqs: [...sourceSeqs],
		operation: before === null ? "append" : after !== null && after.includes(before) ? "merge" : "replace",
		section,
		before,
		after,
		reason: sourceSeqs.length === 0 ? "用户在记忆中心编辑了该记忆。" : "根据用户当前消息更新了该记忆。",
		at: time
	};
}
function auditManualChange(current, next, time, sourceSeqs) {
	const changes = [];
	const beforeProfile = displayProfile(current);
	const afterProfile = displayProfile(next);
	if (beforeProfile !== afterProfile) changes.push(makeActivity("userProfile", beforeProfile, afterProfile, time, sourceSeqs));
	for (const section of ["preferences", "assistantInstructions"]) {
		const before = current[section];
		const after = next[section];
		const ids = /* @__PURE__ */ new Set([...before.map((item) => item.id), ...after.map((item) => item.id)]);
		for (const id of ids) {
			const oldItem = before.find((item) => item.id === id);
			const newItem = after.find((item) => item.id === id);
			const oldText = oldItem === void 0 ? null : `${oldItem.category}：${oldItem.text}`;
			const newText = newItem === void 0 ? null : `${newItem.category}：${newItem.text}`;
			if (oldText !== newText) changes.push(makeActivity(section, oldText, newText, time, sourceSeqs));
		}
	}
	for (const section of ["relationship", "roleplayPreset"]) {
		const before = current[section] === null ? null : JSON.stringify(current[section]);
		const after = next[section] === null ? null : JSON.stringify(next[section]);
		if (before !== after) changes.push(makeActivity(section, before, after, time, sourceSeqs));
	}
	return changes;
}
let SessionMemoryService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _get_decorators;
	let _replace_decorators;
	return class SessionMemoryService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_get_decorators = [Remote("get")];
			_replace_decorators = [Remote("replace")];
			__esDecorate(this, null, _get_decorators, {
				kind: "method",
				name: "get",
				static: false,
				private: false,
				access: {
					has: (obj) => "get" in obj,
					get: (obj) => obj.get
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _replace_decorators, {
				kind: "method",
				name: "replace",
				static: false,
				private: false,
				access: {
					has: (obj) => "replace" in obj,
					get: (obj) => obj.replace
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = [
			"agents",
			"sessions",
			"tools",
			"systemPrompt"
		];
		static Config = z.object({
			maxTextBytes: z.number().step(1).min(1).default(4096),
			maxItemsPerSection: z.number().step(1).min(1).max(3).default(3),
			maxProfileCharacters: z.number().step(1).min(1).default(300),
			autoExtract: z.boolean().default(true),
			extractionMaxTokens: z.number().step(1).min(1).default(1536)
		});
		resolved = __runInitializers(this, _instanceExtraInitializers);
		installedAgents = /* @__PURE__ */ new WeakSet();
		constructor(ctx, config = {}) {
			super(ctx, "sessionMemory");
			this.resolved = {
				maxTextBytes: config.maxTextBytes ?? 4096,
				maxItemsPerSection: Math.min(config.maxItemsPerSection ?? 3, 3),
				maxProfileCharacters: config.maxProfileCharacters ?? 300,
				autoExtract: config.autoExtract ?? true,
				extractionMaxTokens: config.extractionMaxTokens ?? 1536
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
					stateVersion: 2
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
						const merged = mergeExtraction(current, proposal, agent.session.events.findLast((event) => event.type === "session-memory/extraction-result" && event.data.turn === turn)?.data.sourceSeqs ?? [], Date.now());
						if (merged.changes.length === 0) return;
						const validated = resolveDocument({
							expectedRevision: current.revision,
							userProfile: merged.document.userProfile,
							preferences: merged.document.preferences,
							assistantInstructions: merged.document.assistantInstructions,
							relationship: merged.document.relationship,
							roleplayPreset: merged.document.roleplayPreset
						}, merged.document.revision, merged.document.updatedAt, this.resolved);
						if ("code" in validated) {
							ctx.logger.warn(`session-memory extraction rejected for session ${agent.id}: ${validated.message}`);
							return;
						}
						agent.session.append("session-memory/change", {
							version: 2,
							operation: "replace",
							document: validated,
							changes: merged.changes
						}, { ignorable: true });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.logger.warn(`session-memory extraction failed for session ${agent.id}: ${message}`);
					}
				});
			});
		}
		get(agent) {
			this.assertLive(agent);
			return foldSessionMemory(agent.session.events);
		}
		async replace(agent, request) {
			return this.commit(agent, request, []);
		}
		async commit(agent, request, sourceSeqs) {
			this.assertLive(agent);
			const current = foldSessionMemory(agent.session.events).document;
			if (request.expectedRevision !== current.revision) return failure("stale-revision", `expected revision ${request.expectedRevision}; current revision is ${current.revision}`);
			const time = Date.now();
			const resolved = resolveDocument(request, current.revision + 1, time, this.resolved);
			if ("code" in resolved) return {
				ok: false,
				error: resolved
			};
			const changes = auditManualChange(current, resolved, time, sourceSeqs);
			if (changes.length === 0) return {
				ok: true,
				value: foldSessionMemory(agent.session.events)
			};
			agent.session.append("session-memory/change", {
				version: 2,
				operation: "replace",
				document: resolved,
				changes
			}, { ignorable: true });
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
				description: "Read the current compact profile, categorized cards, relationship, preset, and change activity.",
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
				description: "Persist explicit personalization now. Match item cards by category; exact item ids are optional. Merge related details and replace conflicts instead of creating sentence-shaped duplicate cards. Use userProfile only for identity/location/work/skills/life state; preferences for likes/dislikes/choices; assistantInstructions for rules governing assistant answers and behavior. Assistant names, nicknames, self-designations, and relationship-specific titles belong in relationship/roleplay memory; use remember_assistant_identity for an additive identity note and never put it in userProfile or preferences.",
				parameters: {
					action: {
						type: "string",
						required: true,
						enum: [
							"set_user_profile",
							"upsert_item",
							"remove_item",
							"set_relationship",
							"clear_relationship",
							"remember_assistant_identity",
							"set_roleplay_preset",
							"clear_roleplay_preset"
						]
					},
					section: {
						type: "string",
						enum: ["preferences", "assistantInstructions"],
						description: "preferences = user likes/dislikes/choices; assistantInstructions = rules for AI replies/actions."
					},
					category: {
						type: "string",
						description: "Stable category used to merge a card without needing its item id."
					},
					text: {
						type: "string",
						description: "Complete consolidated card/preset text, or one additive assistant identity note for remember_assistant_identity."
					},
					item_id: {
						type: "string",
						description: "Optional exact card id for editing or removal."
					},
					confirmed: {
						type: "string",
						description: "Complete confirmed identity/location/work/skills/life-state profile; exclude preferences and AI rules."
					},
					inferred: {
						type: "string",
						description: "Complete cautious inferred traits; exclude likes/dislikes and rules for AI replies."
					},
					role: { type: "string" },
					mission: { type: "string" },
					guidance: { type: "string" },
					enabled: { type: "boolean" }
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
					const latestUser = exec.agent.session.events.findLast((event) => event.type === "user/message" && event.data.source.kind === "user");
					const sourceSeqs = latestUser === void 0 ? [] : [latestUser.seq];
					const request = {
						expectedRevision: current.revision,
						userProfile: current.userProfile,
						preferences: [...current.preferences],
						assistantInstructions: [...current.assistantInstructions],
						relationship: current.relationship,
						roleplayPreset: current.roleplayPreset
					};
					if (args.action === "set_user_profile") Object.assign(request, { userProfile: {
						confirmed: args.confirmed ?? current.userProfile.confirmed,
						inferred: args.inferred ?? current.userProfile.inferred,
						evidenceSeqs: [.../* @__PURE__ */ new Set([...current.userProfile.evidenceSeqs, ...sourceSeqs])]
					} });
					else if (args.action === "upsert_item" || args.action === "remove_item") {
						if (args.section === void 0) throw new Error("section is required for item actions");
						const entries = [...request[args.section]];
						const byId = args.item_id === void 0 ? -1 : entries.findIndex((entry) => entry.id === args.item_id);
						const byCategory = args.category === void 0 ? -1 : entries.findIndex((entry) => entry.category.toLocaleLowerCase() === args.category?.trim().toLocaleLowerCase());
						const at = byId >= 0 ? byId : byCategory;
						if (args.action === "remove_item") {
							if (at < 0) throw new Error("item_id or matching category is required for remove_item");
							entries.splice(at, 1);
						} else {
							if (args.text === void 0 || args.text.trim().length === 0) throw new Error("text is required for upsert_item");
							if (args.category === void 0 || args.category.trim().length === 0) throw new Error("category is required");
							const next = {
								id: entries[at]?.id ?? `memory-${randomUUID()}`,
								category: args.category,
								text: args.text,
								source: "user",
								evidenceSeqs: [.../* @__PURE__ */ new Set([...entries[at]?.evidenceSeqs ?? [], ...sourceSeqs])]
							};
							if (at >= 0) entries.splice(at, 1, next);
							else if (entries.length < 3) entries.push(next);
							else {
								const shortest = entries.reduce((best, item, index) => item.text.length < entries[best].text.length ? index : best, 0);
								const target = entries[shortest];
								entries.splice(shortest, 1, {
									...target,
									category: `${target.category} / ${next.category}`,
									text: `${target.text}；${next.category}：${next.text}`
								});
							}
						}
						Object.assign(request, { [args.section]: entries });
					} else if (args.action === "set_relationship") {
						if (args.role === void 0 || args.role.trim().length === 0) throw new Error("role is required");
						Object.assign(request, { relationship: {
							role: args.role,
							mission: args.mission ?? current.relationship?.mission ?? "Interact using the relationship explicitly assigned by the user in this session.",
							guidance: args.guidance ?? ""
						} });
					} else if (args.action === "clear_relationship") Object.assign(request, { relationship: null });
					else if (args.action === "remember_assistant_identity") {
						if (args.text === void 0 || args.text.trim().length === 0) throw new Error("text is required");
						Object.assign(request, { roleplayPreset: mergeAssistantIdentity(current.roleplayPreset, args.text, args.enabled) });
					} else if (args.action === "set_roleplay_preset") {
						if (args.text === void 0 || args.text.trim().length === 0) throw new Error("text is required");
						Object.assign(request, { roleplayPreset: {
							enabled: args.enabled ?? true,
							text: args.text
						} });
					} else Object.assign(request, { roleplayPreset: null });
					const result = await this.commit(exec.agent, request, sourceSeqs);
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
})();
//#endregion
export { EXTRACTION_SYSTEM as a, parseExtraction as c, emptySessionMemory as d, emptySessionMemoryFoldState as f, sessionMemoryView as h, DEFAULT_RELATIONSHIP_MISSION as i, turnExtractionInput as l, migrateLegacyDocument as m, renderSessionMemory as n, MAX_MEMORY_CARDS as o, foldSessionMemory as p, DEFAULT_PROFILE_CHARACTERS as r, mergeExtraction as s, SessionMemoryService as t, applySessionMemoryEvent as u };
