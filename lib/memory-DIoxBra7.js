import { TYPERT } from "./typert.js";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
//#region src/memory/fold.ts
const DEFAULT_COMPACTION_POLICY = Object.freeze({
	enabled: true,
	thresholdRatio: .164,
	retainTokens: 64e3,
	maxTokens: 6e3,
	updatedAt: 0
});
/**
* Produce the exact plain-data shape used on the Typert Remote boundary.
*
* Early preview events did not all carry `updatedAt`.  They remain useful
* historical settings, but must never make the read-only settings screen fail
* its strict result validation.
*/
function normalizeCompactionPolicy(value) {
	const candidate = value !== null && typeof value === "object" ? value : {};
	const thresholdRatio = Number.isFinite(candidate.thresholdRatio) && candidate.thresholdRatio >= .05 && candidate.thresholdRatio <= .8 ? candidate.thresholdRatio : DEFAULT_COMPACTION_POLICY.thresholdRatio;
	const retainTokens = Number.isInteger(candidate.retainTokens) && candidate.retainTokens >= 4096 ? candidate.retainTokens : DEFAULT_COMPACTION_POLICY.retainTokens;
	const maxTokens = Number.isInteger(candidate.maxTokens) && candidate.maxTokens >= 512 && candidate.maxTokens <= 8192 ? candidate.maxTokens : DEFAULT_COMPACTION_POLICY.maxTokens;
	return {
		enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : DEFAULT_COMPACTION_POLICY.enabled,
		thresholdRatio,
		retainTokens,
		maxTokens,
		updatedAt: Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : 0
	};
}
/** Empty state before a session has personalization edits. */
function emptySessionMemory() {
	return {
		version: 3,
		revision: 0,
		userProfile: {
			confirmed: "",
			pendingConfirmation: "",
			confirmedEvidenceSeqs: [],
			pendingEvidenceSeqs: []
		},
		preferences: [],
		assistantRequirements: [],
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
			pendingConfirmation: document.userProfile.pendingConfirmation.trim(),
			confirmedEvidenceSeqs: [...new Set(document.userProfile.confirmedEvidenceSeqs)],
			pendingEvidenceSeqs: [...new Set(document.userProfile.pendingEvidenceSeqs)]
		},
		preferences: normalizeMemoryCards(document.preferences, "综合偏好"),
		assistantRequirements: normalizeMemoryCards(document.assistantRequirements, "对AI的要求")
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
		version: 3,
		revision: document.revision,
		userProfile: {
			confirmed: facts.join("；"),
			pendingConfirmation: "",
			confirmedEvidenceSeqs: [...new Set(factEvidence)],
			pendingEvidenceSeqs: []
		},
		preferences: migrateLegacyCards(document.preferences, "综合偏好"),
		assistantRequirements: migrateLegacyCards(document.assistantInstructions, "对AI的要求"),
		relationship: migrateRelationship(document.relationship, document.updatedAt),
		roleplayPreset: document.roleplayPreset ?? null,
		updatedAt: document.updatedAt
	};
}
function migrateRelationship(relationship, updatedAt) {
	if (relationship === null) return null;
	const history = relationship.mission.trim().length === 0 ? relationship.guidance.trim() : [relationship.guidance.trim(), `历史上曾设定目标“${relationship.mission.trim()}”，仅作背景，不构成永久使命。`].filter(Boolean).join("；");
	return {
		status: relationship.role.trim(),
		context: history,
		updatedAt
	};
}
/** Migrate the v0.2 profile and permanent-mission relationship into v0.3 semantics. */
function migrateV2Document(document) {
	return normalizeSessionMemoryDocument({
		version: 3,
		revision: document.revision,
		userProfile: {
			confirmed: document.userProfile.confirmed,
			pendingConfirmation: document.userProfile.inferred,
			confirmedEvidenceSeqs: [...document.userProfile.evidenceSeqs],
			pendingEvidenceSeqs: [...document.userProfile.evidenceSeqs]
		},
		preferences: [...document.preferences],
		assistantRequirements: [...document.assistantInstructions],
		relationship: migrateRelationship(document.relationship, document.updatedAt),
		roleplayPreset: document.roleplayPreset,
		updatedAt: document.updatedAt
	});
}
/** Initial replay state. */
function emptySessionMemoryFoldState() {
	return {
		document: emptySessionMemory(),
		memoryActivity: [],
		compactionPolicy: DEFAULT_COMPACTION_POLICY
	};
}
/** Apply one relevant event without scanning prior history. */
function applySessionMemoryEvent(state, event) {
	if (event.type === "mindspace-compaction/policy") {
		const value = event.data;
		const normalized = normalizeCompactionPolicy(value);
		if (value !== null && typeof value === "object" && "enabled" in value && "thresholdRatio" in value && "retainTokens" in value && "maxTokens" in value) return {
			...state,
			compactionPolicy: normalized
		};
	}
	if (event.type !== "session-memory/change") return state;
	if (event.data.version === 1) return {
		...state,
		document: migrateLegacyDocument(event.data.document)
	};
	if (event.data.version === 2) return {
		...state,
		document: migrateV2Document(event.data.document)
	};
	return {
		...state,
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
/** Read the policy without widening the established sessionMemory/get wire contract. */
function foldCompactionPolicy(events) {
	let state = emptySessionMemoryFoldState();
	for (const event of events) state = applySessionMemoryEvent(state, event);
	return normalizeCompactionPolicy(state.compactionPolicy);
}
/** Fold one log into its latest editable document and activity ledger. */
function foldSessionMemory(events) {
	let state = emptySessionMemoryFoldState();
	for (const event of events) state = applySessionMemoryEvent(state, event);
	return sessionMemoryView(state);
}
//#endregion
//#region src/memory/compaction-bridge.ts
/** Public structural boundary; DSH 0.1.x's BasicCompactionEngine satisfies this shape. */
function isMutableProvider(value) {
	if (value === null || typeof value !== "object") return false;
	const candidate = value;
	return typeof candidate.compactIfNeeded === "function" && typeof candidate.compactNow === "function" && candidate.config !== null && typeof candidate.config === "object" && Array.isArray(candidate.config.modelPolicies);
}
function routedTarget(agent) {
	const route = agent.session.requestHeader()?.config;
	if (route !== void 0 && route.provider.length > 0 && route.model.length > 0) return {
		provider: route.provider,
		model: route.model
	};
	if (agent.options.provider === void 0 || agent.options.model === void 0) return void 0;
	if (agent.options.provider.length === 0 || agent.options.model.length === 0) return void 0;
	return {
		provider: agent.options.provider,
		model: agent.options.model
	};
}
/** Build an isolated stock-provider config with this session's explicit values. */
function withSessionCompactionPolicy(config, target, policy, contextWindow) {
	const safeRetainRatio = Math.min(.16, policy.thresholdRatio / 2);
	const retention = contextWindow !== void 0 && Number.isInteger(contextWindow) && contextWindow > 0 ? {
		retainTokens: Math.min(policy.retainTokens, Math.floor(contextWindow * safeRetainRatio)),
		retainRatio: void 0
	} : {
		retainTokens: void 0,
		retainRatio: safeRetainRatio
	};
	const base = {
		...config,
		thresholdRatio: policy.thresholdRatio,
		...retention,
		maxTokens: policy.maxTokens,
		modelPolicies: [...config.modelPolicies]
	};
	if (target === void 0) return base;
	const override = {
		...config.modelPolicies.find((item) => item.provider === target.provider && item.model === target.model),
		provider: target.provider,
		model: target.model,
		thresholdRatio: policy.thresholdRatio,
		...retention,
		maxTokens: policy.maxTokens
	};
	return {
		...base,
		modelPolicies: [override, ...config.modelPolicies.filter((item) => item.provider !== target.provider || item.model !== target.model)]
	};
}
/**
* Install once and bridge every compaction provider visible from an agent scope.
*
* DSH Web deliberately disables the host-plane compaction rows and mounts the
* engine plus `/compact` inside the standing Agent preset. Looking up
* `ctx.compaction` here therefore reaches the wrong service (or no service at
* all). The live provider must be resolved through `agent.ctx` after preset
* composition. A standing preset shares one provider between its sessions, so
* calls are serialized around a temporary config swap.
*/
function installSessionCompactionPolicyBridge(ctx, policyFor) {
	const patches = /* @__PURE__ */ new Map();
	const ensureProvider = (agent) => {
		const candidate = agent.ctx.get("compaction");
		if (!isMutableProvider(candidate) || patches.has(candidate)) return;
		const provider = candidate;
		const original = provider.compactIfNeeded;
		const originalNow = provider.compactNow;
		let tail = Promise.resolve();
		const withPolicy = async (agent, signal, operation) => {
			const policy = policyFor(agent);
			const previous = tail;
			let release;
			tail = new Promise((resolve) => {
				release = resolve;
			});
			await previous;
			const previousConfig = provider.config;
			const target = routedTarget(agent);
			let contextWindow;
			if (target !== void 0) {
				const llm = agent.ctx.get("llm");
				try {
					contextWindow = (await llm?.resolveModelInfo(target.provider, target.model, signal))?.context?.contextWindow;
				} catch {}
			}
			provider.config = withSessionCompactionPolicy(previousConfig, target, policy, contextWindow);
			try {
				return await operation();
			} finally {
				provider.config = previousConfig;
				release?.();
			}
		};
		const wrappedIfNeeded = async (agent, trigger, signal) => {
			const policy = policyFor(agent);
			if (trigger === "pressure" && !policy.enabled) return null;
			return await withPolicy(agent, signal, () => original.call(provider, agent, trigger, signal));
		};
		const wrappedNow = async (agent, signal, sourceCommandId) => await withPolicy(agent, signal, () => originalNow.call(provider, agent, signal, sourceCommandId));
		provider.compactIfNeeded = wrappedIfNeeded;
		provider.compactNow = wrappedNow;
		patches.set(provider, {
			provider,
			compactIfNeeded: original,
			compactNow: originalNow,
			wrappedIfNeeded,
			wrappedNow
		});
	};
	for (const agent of ctx.agents.roots()) ensureProvider(agent);
	ctx.on("agent/created", ({ agent }) => {
		ensureProvider(agent);
	});
	ctx.on("agent/pre-step", ({ agent }, next) => {
		ensureProvider(agent);
		return next();
	});
	ctx.effect(() => () => {
		for (const patch of patches.values()) {
			if (patch.provider.compactIfNeeded === patch.wrappedIfNeeded) patch.provider.compactIfNeeded = patch.compactIfNeeded;
			if (patch.provider.compactNow === patch.wrappedNow) patch.provider.compactNow = patch.compactNow;
		}
		patches.clear();
	}, "mindspace-session-memory: scoped compaction policy bridges");
}
//#endregion
//#region src/memory/sidecar.ts
/**
* Durable per-session storage outside DSH's canonical conversation event log.
*
* RC8 deliberately has no registration surface for third-party session event
* types.  A plugin must therefore never use `Session.append()` as its durable
* store: unknown event envelopes make a later stock DSH replay refuse the
* complete conversation.  This small sidecar store imports the legacy fold on
* first access, then owns all subsequent personalization and policy writes.
*/
function dshHome() {
	return process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
}
function sessionFilename(id) {
	return `${createHash("sha256").update(id).digest("hex")}.json`;
}
function isStored(value, sessionId) {
	if (value === null || typeof value !== "object") return false;
	const item = value;
	return item.format === 3 && item.sessionId === sessionId && item.view !== void 0 && typeof item.view === "object" && item.compactionPolicy !== void 0 && typeof item.compactionPolicy === "object";
}
function isStoredV2(value, sessionId) {
	if (value === null || typeof value !== "object") return false;
	const item = value;
	return item.format === 2 && item.sessionId === sessionId && item.view !== void 0 && typeof item.view === "object" && item.compactionPolicy !== void 0 && typeof item.compactionPolicy === "object";
}
function migrateActivity(activity) {
	return activity.section === "assistantInstructions" ? {
		...activity,
		section: "assistantRequirements"
	} : activity;
}
function legacyMemoryView(events) {
	let document = emptySessionMemory();
	let lastSeq = -1;
	for (const raw of events) {
		if (raw === null || typeof raw !== "object") continue;
		const event = raw;
		if (typeof event.type !== "string" || !event.type.startsWith("memory/") || event.data === null || typeof event.data !== "object") continue;
		const data = event.data;
		lastSeq = typeof event.seq === "number" ? event.seq : lastSeq;
		if (event.type === "memory/set") {
			const slot = data.slot;
			const text = typeof data.text === "string" ? data.text.trim() : "";
			if (slot !== "preferences" && slot !== "instructions" || text.length === 0) continue;
			const section = slot === "preferences" ? "preferences" : "assistantRequirements";
			const id = typeof data.id === "string" && data.id.trim().length > 0 ? data.id : `legacy-${section}-${lastSeq}`;
			const item = {
				id,
				category: typeof data.category === "string" && data.category.trim().length > 0 ? data.category : slot === "preferences" ? "综合偏好" : "交互要求",
				text,
				source: data.source === "extracted" ? "extracted" : "user",
				evidenceSeqs: typeof data.evidenceSeq === "number" ? [data.evidenceSeq] : []
			};
			const existing = document[section].filter((value) => value.id !== id);
			document = {
				...document,
				[section]: [...existing, item],
				revision: Math.max(document.revision, 1),
				updatedAt: Date.now()
			};
		} else if (event.type === "memory/remove") {
			const section = data.slot === "preferences" ? "preferences" : data.slot === "instructions" ? "assistantInstructions" : void 0;
			if (section === void 0 || typeof data.id !== "string") continue;
			const currentSection = section === "assistantInstructions" ? "assistantRequirements" : section;
			document = {
				...document,
				[currentSection]: document[currentSection].filter((value) => value.id !== data.id),
				revision: Math.max(document.revision, 1),
				updatedAt: Date.now()
			};
		} else if (event.type === "memory/relationship") {
			const role = typeof data.role === "string" ? data.role.trim() : "";
			if (role.length === 0) continue;
			document = {
				...document,
				relationship: {
					status: role,
					context: [typeof data.personaText === "string" ? data.personaText.trim() : "", typeof data.mission === "string" && data.mission.trim().length > 0 ? `历史上曾设定目标“${data.mission.trim()}”，仅作背景，不构成永久使命。` : ""].filter(Boolean).join("；"),
					updatedAt: Date.now()
				},
				revision: Math.max(document.revision, 1),
				updatedAt: Date.now()
			};
		}
	}
	return {
		view: {
			document: normalizeSessionMemoryDocument(document),
			memoryActivity: []
		},
		lastSeq
	};
}
function importedView(session) {
	const modern = foldSessionMemory(session.events);
	const modernSeq = session.events.findLast((event) => event.type === "session-memory/change")?.seq ?? -1;
	const legacy = legacyMemoryView(session.events);
	return legacy.lastSeq > modernSeq ? legacy.view : modern;
}
/** Synchronous, tiny JSON cache: prompt assembly must remain synchronous. */
var SessionMemorySidecar = class {
	root = join(dshHome(), "mindspace-session-memory", "v1");
	cache = /* @__PURE__ */ new Map();
	read(session) {
		const cached = this.cache.get(session.id);
		if (cached !== void 0) return cached;
		const path = this.pathFor(session.id);
		if (existsSync(path)) try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (isStored(parsed, session.id)) {
				const stored = {
					...parsed,
					compactionPolicy: normalizeCompactionPolicy(parsed.compactionPolicy)
				};
				this.cache.set(session.id, stored);
				return stored;
			}
			if (isStoredV2(parsed, session.id)) {
				const migrated = {
					format: 3,
					sessionId: session.id,
					view: {
						document: migrateV2Document(parsed.view.document),
						memoryActivity: parsed.view.memoryActivity.map(migrateActivity)
					},
					compactionPolicy: normalizeCompactionPolicy(parsed.compactionPolicy),
					writtenAt: Date.now()
				};
				this.write(migrated);
				return migrated;
			}
		} catch {}
		const imported = {
			format: 3,
			sessionId: session.id,
			view: importedView(session),
			compactionPolicy: foldCompactionPolicy(session.events),
			writtenAt: Date.now()
		};
		this.write(imported);
		return imported;
	}
	replace(session, view) {
		const next = {
			...this.read(session),
			view,
			writtenAt: Date.now()
		};
		this.write(next);
		return next;
	}
	setPolicy(session, policy) {
		const next = {
			...this.read(session),
			compactionPolicy: normalizeCompactionPolicy(policy),
			writtenAt: Date.now()
		};
		this.write(next);
		return next;
	}
	pathFor(sessionId) {
		return join(this.root, sessionFilename(sessionId));
	}
	write(value) {
		mkdirSync(this.root, { recursive: true });
		const target = this.pathFor(value.sessionId);
		const temporary = join(this.root, `.${sessionFilename(value.sessionId)}.${randomUUID()}.tmp`);
		writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
			encoding: "utf8",
			flag: "wx"
		});
		renameSync(temporary, target);
		this.cache.set(value.sessionId, value);
	}
};
//#endregion
//#region src/memory/extraction.ts
/** DeepSeek-compatible auxiliary extraction and whole-state memory consolidation. */
const MAX_MEMORY_CARDS = 3;
const DEFAULT_PROFILE_CHARACTERS = 300;
const EXTRACTION_SYSTEM = [
	"Consolidate durable session-local personalization from the newest USER message into the COMPLETE current memory state.",
	"Return JSON only with keys userProfile, preferences, assistantRequirements, relationship, roleplayPreset, atoms.",
	"userProfile is {confirmed,pendingConfirmation} and contains only information about the user. confirmed is relatively",
	"stable information directly stated or strongly confirmed by the user. pendingConfirmation is plausible user information",
	"still awaiting confirmation; revise, remove, or promote it when later evidence arrives. Neither field may contain an AI",
	"persona, relationship narrative, likes, or assistant rules. Keep their combined text at or below 300 Chinese characters.",
	"preferences and assistantRequirements are complete arrays of at most 3 {category,text} cards. Preferences are user",
	"likes, dislikes, topics, activities, tools and habits. assistantRequirements contains only explicit rules addressed to",
	"the assistant: must, should, do not, prohibitions and interaction rules. Do not turn a preference into a command.",
	"A card is a compact",
	"structured category containing all related details. Merge new details into the best existing card; do not append a",
	"sentence-shaped card when a category can absorb it. A newer explicit correction replaces conflicting old content.",
	"A proposed destructive overwrite receives a second evidence review, so preserve an old card whenever the newest",
	"user message merely adds detail instead of explicitly correcting or withdrawing it.",
	"For “not X but Y” corrections, remove X instead of preserving “does not use X” unless the user separately states",
	"that avoiding X is itself a durable preference.",
	"Preserve every unaffected current fact and card. relationship is null or {status,context}; it describes the current",
	"revisable relationship and may progress, weaken, end, or clear. It is never a permanent mission, identity, or obligation.",
	"roleplayPreset is null or {enabled,text}, requires explicit user authorship, and must not grow from ordinary interaction.",
	"Judge only user text. Never invent sensitive facts. The",
	"response is rejected atomically if incomplete or invalid. Return atoms as a compact audit list only for durable",
	"updates you actually propose: {text,disposition:\"handled\"|\"skipped\",section,reason}. Use [] when this turn has",
	"no durable memory update. Do not enumerate ordinary conversation claims, do not think aloud, and emit JSON only."
].join(" ");
/** A compact, evidence-bound prompt used only after an automatic overwrite is proposed. */
const OVERWRITE_REVIEW_SYSTEM = [
	"You are reviewing a proposed automatic update to session-local memory. Return JSON only as",
	"{\"decisions\":[{\"section\":\"...\",\"before\":\"...\",\"after\":\"...\"|null,\"approved\":true|false,\"reason\":\"...\"}]}.",
	"Review only the supplied candidates. Approve a replacement or removal only when the newest USER evidence",
	"explicitly corrects, supersedes, or withdraws the exact prior fact/rule. New detail that does not directly",
	"contradict the old value must be rejected here so the normal merge path preserves both facts. Never approve",
	"a deletion merely because a complete-state proposal omitted a card. Every candidate needs one concise decision",
	"and a reason that cites the supplied user evidence; do not infer intent from assistant text."
].join(" ");
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
	"assistantRequirements",
	"relationship",
	"roleplayPreset"
]);
function parseAtoms(value) {
	if (!Array.isArray(value) || value.length > 64) return void 0;
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
	const status = clean(row["status"]);
	const context = clean(row["context"]);
	if (status === void 0 || status.length === 0 || context === void 0) return;
	return {
		status,
		context,
		updatedAt: 0
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
		const pendingConfirmation = clean(profileRecord["pendingConfirmation"]);
		if (confirmed === void 0 || pendingConfirmation === void 0) return void 0;
		if ([...`${confirmed}${pendingConfirmation}`].length > 300) return void 0;
		const preferences = parseCards(record["preferences"]);
		const assistantRequirements = parseCards(record["assistantRequirements"]);
		const relationship = parseRelationship(record["relationship"]);
		const roleplayPreset = parseRoleplayPreset(record["roleplayPreset"]);
		const atoms = parseAtoms(record["atoms"]);
		if (preferences === void 0 || assistantRequirements === void 0 || relationship === void 0 || roleplayPreset === void 0 || atoms === void 0) return void 0;
		return {
			userProfile: {
				confirmed,
				pendingConfirmation
			},
			preferences,
			assistantRequirements,
			relationship,
			roleplayPreset,
			atoms
		};
	} catch (_invalidJson) {
		return;
	}
}
function overwriteKey(candidate) {
	return JSON.stringify([
		candidate.section,
		candidate.before,
		candidate.after
	]);
}
/**
* A review is valid only when it accounts for every exact proposed overwrite.
* Missing or altered candidates intentionally fail closed so an unrelated model
* answer cannot authorize deletion of durable user data.
*/
function parseOverwriteReview(text, candidates) {
	try {
		const value = JSON.parse(text);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
		const rows = value["decisions"];
		if (!Array.isArray(rows) || rows.length !== candidates.length) return void 0;
		const expected = new Set(candidates.map(overwriteKey));
		const decisions = [];
		for (const rowValue of rows) {
			if (typeof rowValue !== "object" || rowValue === null || Array.isArray(rowValue)) return void 0;
			const row = rowValue;
			const section = clean(row["section"]);
			const before = clean(row["before"]);
			const after = row["after"] === null ? null : clean(row["after"]);
			const reason = clean(row["reason"]);
			if (section === void 0 || !SECTIONS.has(section) || before === void 0 || after === void 0 || reason === void 0 || typeof row["approved"] !== "boolean") return;
			const decision = {
				section,
				before,
				after,
				approved: row["approved"],
				reason
			};
			const key = overwriteKey(decision);
			if (!expected.delete(key)) return void 0;
			decisions.push(decision);
		}
		return expected.size === 0 ? decisions : void 0;
	} catch (_invalidJson) {
		return;
	}
}
/**
* Ask the model to justify only destructive automatic mutations. The caller
* passes raw user evidence and the exact before/after values, so the reviewer
* cannot treat an omitted complete-state card as permission to delete it.
*/
async function reviewOverwrites(ctx, agent, turn, current, userEvidence, candidates, maxTokens, signal) {
	if (candidates.length === 0) return [];
	const route = agent.session.requestHeader()?.config;
	if (route === void 0) return void 0;
	const { BlockAssembler, createUserMessage, deepFreeze } = await import("@deepseek-ai/dsh-llm");
	const input = JSON.stringify({
		turn,
		newestUserEvidence: userEvidence,
		currentMemory: current,
		candidateOverwrites: candidates
	});
	const assembler = new BlockAssembler();
	const request = deepFreeze({
		provider: route.provider,
		model: route.model,
		messages: [createUserMessage({
			content: [{
				type: "text",
				text: input
			}],
			source: {
				kind: "plugin",
				plugin: "dsh-session-memory-governance"
			}
		})],
		system: OVERWRITE_REVIEW_SYSTEM,
		maxTokens: Math.min(Math.max(maxTokens, 1024), 1536),
		sessionId: agent.id,
		signal
	});
	for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk);
	return parseOverwriteReview(assembler.blocks().filter((block) => block.type === "text").map((block) => block.text).join("").trim(), candidates);
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
function skippedOverwrite(section, sourceSeqs, time, reason) {
	return {
		id: `activity-${randomUUID()}`,
		sourceSeqs: [...sourceSeqs],
		operation: "skip",
		section,
		before: null,
		after: null,
		reason,
		at: time
	};
}
function overwriteDecision(approvals, section, before, after) {
	if (approvals === void 0) return {
		section,
		before,
		after,
		approved: true,
		reason: "No separate overwrite review was required."
	};
	return approvals.find((candidate) => candidate.section === section && candidate.before === before && candidate.after === after);
}
function reconcileCards(section, current, proposed, evidenceSeqs, time, approvals) {
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
		const before = previous === void 0 ? null : cardText(previous);
		const after = cardText(next);
		const mutation = before === null ? "append" : operation(before, after);
		if (before !== null && mutation === "replace") {
			const decision = overwriteDecision(approvals, section, before, after);
			if (decision?.approved !== true) {
				items.push(previous);
				changes.push(skippedOverwrite(section, evidenceSeqs, time, `Preserved the existing card because overwrite review did not approve it: ${decision?.reason ?? "missing decision."}`));
				continue;
			}
		}
		items.push(next);
		if (!unchanged) changes.push(activity(section, before, after, evidenceSeqs, time, previous === void 0 ? "Added a durable category from explicit user evidence." : mutation === "replace" ? `Replaced the category after explicit overwrite review: ${overwriteDecision(approvals, section, before, after)?.reason ?? "approved."}` : "Consolidated the newest explicit user evidence into its existing category."));
	}
	for (const removed of available) {
		const before = cardText(removed);
		const decision = overwriteDecision(approvals, section, before, null);
		if (decision?.approved !== true) {
			items.push(removed);
			changes.push(skippedOverwrite(section, evidenceSeqs, time, `Preserved the omitted card because deletion review did not approve it: ${decision?.reason ?? "missing decision."}`));
			continue;
		}
		changes.push(activity(section, before, null, evidenceSeqs, time, `Removed or superseded after explicit overwrite review: ${decision.reason}`));
	}
	return {
		items,
		changes
	};
}
/** Atomically reconcile one complete proposal against current memory without model-supplied item ids. */
function mergeExtraction(document, proposal, evidenceSeqs, time, options = {}) {
	const approvals = options.overwriteApprovals;
	const preferences = reconcileCards("preferences", document.preferences, proposal.preferences, evidenceSeqs, time, approvals);
	const requirements = reconcileCards("assistantRequirements", document.assistantRequirements, proposal.assistantRequirements, evidenceSeqs, time, approvals);
	const changes = [...preferences.changes, ...requirements.changes];
	const proposedProfileChanged = normalized(document.userProfile.confirmed) !== normalized(proposal.userProfile.confirmed) || normalized(document.userProfile.pendingConfirmation) !== normalized(proposal.userProfile.pendingConfirmation);
	const profileBefore = document.userProfile.confirmed.length === 0 && document.userProfile.pendingConfirmation.length === 0 ? null : `已确认：${document.userProfile.confirmed}\n待确认：${document.userProfile.pendingConfirmation}`;
	const profileAfter = `已确认：${proposal.userProfile.confirmed}\n待确认：${proposal.userProfile.pendingConfirmation}`;
	const profileApproval = profileBefore === null || !proposedProfileChanged ? void 0 : overwriteDecision(approvals, "userProfile", profileBefore, profileAfter);
	const profileChanged = proposedProfileChanged && (profileBefore === null || profileApproval?.approved === true);
	const userProfile = profileChanged ? {
		...proposal.userProfile,
		confirmedEvidenceSeqs: normalized(document.userProfile.confirmed) === normalized(proposal.userProfile.confirmed) ? [...document.userProfile.confirmedEvidenceSeqs] : [.../* @__PURE__ */ new Set([...document.userProfile.confirmedEvidenceSeqs, ...evidenceSeqs])],
		pendingEvidenceSeqs: normalized(document.userProfile.pendingConfirmation) === normalized(proposal.userProfile.pendingConfirmation) ? [...document.userProfile.pendingEvidenceSeqs] : [.../* @__PURE__ */ new Set([...document.userProfile.pendingEvidenceSeqs, ...evidenceSeqs])]
	} : document.userProfile;
	if (proposedProfileChanged && !profileChanged) changes.unshift(skippedOverwrite("userProfile", evidenceSeqs, time, `Preserved the profile because overwrite review did not approve it: ${profileApproval?.reason ?? "missing decision."}`));
	else if (profileChanged) changes.unshift(activity("userProfile", profileBefore, profileAfter, evidenceSeqs, time, profileBefore === null ? "Created the compact profile from explicit user evidence." : `Rewrote the compact profile after explicit overwrite review: ${profileApproval?.reason ?? "approved."}`));
	const nextRelationship = { value: proposal.relationship === null ? null : {
		...proposal.relationship,
		updatedAt: time
	} };
	const nextRoleplayPreset = { value: proposal.roleplayPreset };
	for (const [section, before, after] of [[
		"relationship",
		document.relationship,
		nextRelationship.value
	], [
		"roleplayPreset",
		document.roleplayPreset,
		proposal.roleplayPreset
	]]) if (JSON.stringify(before) !== JSON.stringify(after)) {
		const beforeText = objectText(before);
		const afterText = objectText(after);
		const decision = beforeText === null ? void 0 : overwriteDecision(approvals, section, beforeText, afterText);
		if (beforeText !== null && decision?.approved !== true) {
			if (section === "relationship") nextRelationship.value = before;
			else nextRoleplayPreset.value = before;
			changes.push(skippedOverwrite(section, evidenceSeqs, time, `Preserved the existing assignment because overwrite review did not approve it: ${decision?.reason ?? "missing decision."}`));
			continue;
		}
		changes.push(activity(section, beforeText, afterText, evidenceSeqs, time, beforeText === null ? "Applied a new explicit session assignment." : `Applied an explicit session assignment after overwrite review: ${decision?.reason ?? "approved."}`));
	}
	const changed = changes.some((change) => change.operation !== "skip");
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
			version: 3,
			revision: changed ? document.revision + 1 : document.revision,
			userProfile,
			preferences: preferences.items,
			assistantRequirements: requirements.items,
			relationship: nextRelationship.value,
			roleplayPreset: nextRoleplayPreset.value,
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
/** Run one auxiliary extraction request. Durable state is owned by the sidecar store. */
async function extractTurn(ctx, agent, turn, current, maxTokens, signal) {
	const { BlockAssembler, createUserMessage, deepFreeze } = await import("@deepseek-ai/dsh-llm");
	const input = turnExtractionInput(agent.session.events, turn);
	const route = agent.session.requestHeader()?.config;
	if (input === void 0 || route === void 0) return void 0;
	const extractionInput = `${input.input}\n\nCURRENT_SESSION_MEMORY:\n${JSON.stringify(current)}`;
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
	return parseExtraction(assembler.blocks().filter((block) => block.type === "text").map((block) => block.text).join("").trim());
}
//#endregion
//#region src/memory/render.ts
function cards(label, values) {
	return values.length === 0 ? "" : `${label}\n${values.map((value) => `- ${value.category}: ${value.text}`).join("\n")}`;
}
/** Render only categorized personalization; it never replaces the agent's identity. */
function renderSessionMemory(view) {
	const { document } = view;
	const profile = document.userProfile.confirmed.length === 0 && document.userProfile.pendingConfirmation.length === 0 ? "" : [
		"Compact user profile for this conversation:",
		document.userProfile.confirmed.length === 0 ? "" : `- Confirmed by user: ${document.userProfile.confirmed}`,
		document.userProfile.pendingConfirmation.length === 0 ? "" : `- Pending confirmation; revise or promote only when later user evidence supports it: ${document.userProfile.pendingConfirmation}`
	].filter(Boolean).join("\n");
	const relationship = document.relationship === null ? "" : [
		"Current relationship state for this conversation:",
		`- Status: ${document.relationship.status}`,
		document.relationship.context.length === 0 ? "" : `- Current context: ${document.relationship.context}`,
		"- This state is descriptive and revisable. It is not a permanent identity, mission, or obligation."
	].filter(Boolean).join("\n");
	const roleplayPreset = document.roleplayPreset?.enabled === true ? `User-authored roleplay preset for this conversation only:\n${document.roleplayPreset.text}` : "";
	return [
		"Session-local personalization. Apply it only in this conversation and do not infer it for other sessions.",
		profile,
		cards("Categorized user preferences:", document.preferences),
		cards("Explicit requirements from the user for assistant behavior:", document.assistantRequirements),
		relationship,
		roleplayPreset
	].filter(Boolean).join("\n\n");
}
//#endregion
//#region src/memory/usage.ts
/** Capacity accounting for the user-editable session-memory document. */
const DEFAULT_AUTO_EXTRACT_BELOW_UTILIZATION = .2;
/**
* Measures only editable, persisted memory against this plugin's actual field
* limits. System prompts, RAG, compaction summaries, evidence ids and event
* history are deliberately excluded: none of them consumes the user's memory
* document capacity.
*/
function sessionMemoryUtilization(document, limits) {
	const bytes = (text) => Buffer.byteLength(text, "utf8");
	const used = bytes(document.userProfile.confirmed) + bytes(document.userProfile.pendingConfirmation) + document.preferences.reduce((total, item) => total + bytes(item.category) + bytes(item.text), 0) + document.assistantRequirements.reduce((total, item) => total + bytes(item.category) + bytes(item.text), 0) + (document.relationship === null ? 0 : bytes(document.relationship.status) + bytes(document.relationship.context)) + (document.roleplayPreset === null ? 0 : bytes(document.roleplayPreset.text));
	const capacity = limits.maxProfileCharacters * 4 + limits.maxItemsPerSection * limits.maxTextBytes * 4 + limits.maxTextBytes * 4;
	return capacity === 0 ? 1 : Math.min(1, used / capacity);
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
	pendingConfirmation: z$1.string(),
	confirmedEvidenceSeqs: z$1.array(z$1.number()),
	pendingEvidenceSeqs: z$1.array(z$1.number())
});
const relationshipSchema = z$1.object({
	status: z$1.string(),
	context: z$1.string(),
	updatedAt: z$1.number()
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
		"assistantRequirements",
		"relationship",
		"roleplayPreset"
	]),
	before: z$1.string().nullable(),
	after: z$1.string().nullable(),
	reason: z$1.string(),
	at: z$1.number()
});
const documentSchema = z$1.object({
	version: z$1.literal(3),
	revision: z$1.number(),
	userProfile: userProfileSchema,
	preferences: z$1.array(memoryItemSchema),
	assistantRequirements: z$1.array(memoryItemSchema),
	relationship: relationshipSchema.nullable(),
	roleplayPreset: roleplayPresetSchema.nullable(),
	updatedAt: z$1.number()
});
z$1.object({
	document: documentSchema,
	memoryActivity: z$1.array(activitySchema)
});
const MEMORY_TOOL_GUIDANCE = [
	"Session memory follows an explicit taxonomy. Before every write, call get_session_memory and classify the information",
	"against the existing state; update or replace the matching category instead of appending sentence-shaped duplicates.",
	"User profile contains only information about the user. confirmed is revisable, relatively stable information supported",
	"by the user’s direct statement or later strong evidence: identity, age, gender, location, occupation, skills, and stable",
	"life state. pendingConfirmation is also revisable and stores plausible user information that still needs confirmation;",
	"change, remove, or promote it as later user answers provide evidence. Never derive either field from persona, roleplay,",
	"relationship, or the assistant’s own narrative. Preferences describe the user’s likes, dislikes, choices, recurring",
	"activities, topics, tools, work habits, and preferred kinds of communication. “I like direct people” is a preference.",
	"assistantRequirements contains only explicit requirements addressed to the AI: must, should, do not, prohibitions,",
	"and stable interaction rules. “You must answer directly” is a requirement. Do not turn a preference into a command.",
	"Relationship memory is a current, revisable status inferred from relationship-relevant interaction. It may progress,",
	"weaken, end, or be cleared; it never becomes a permanent identity, mission, or obligation and never overrides the",
	"Harness identity. Roleplay presets and assistant identity notes require explicit user authorship and must not expand",
	"automatically from ordinary interaction. Do not write one-off tasks or small talk. These tools affect only this session."
].join(" ");
const NEW_SESSION_ONBOARDING = ["This session has no personalization yet. Address the user request normally. Do not force onboarding questions.", "Only when the user provides durable personalization, read memory first and store it under the explicit taxonomy."].join(" ");
function isEmptyDocument(document) {
	return document.userProfile.confirmed.length === 0 && document.userProfile.pendingConfirmation.length === 0 && document.preferences.length === 0 && document.assistantRequirements.length === 0 && document.relationship === null && document.roleplayPreset === null;
}
/** A model-owned memory write during this turn makes the cold-start fallback redundant. */
function turnAlreadyWroteSessionMemory(events, turn) {
	let start = -1;
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event.type === "turn/start" && event.data.turn === turn) {
			start = index;
			break;
		}
	}
	return start >= 0 && events.slice(start + 1).some((event) => event.type === "session-memory/change");
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
	for (const [field, items] of [["preferences", request.preferences], ["assistantRequirements", request.assistantRequirements]]) {
		const invalid = validateItems(items, field, config);
		if (invalid !== void 0) return invalid;
	}
	const profileCharacters = [...`${request.userProfile.confirmed}${request.userProfile.pendingConfirmation}`].length;
	if (profileCharacters > config.maxProfileCharacters) return {
		code: "text-too-large",
		message: `userProfile is ${profileCharacters} characters; limit is ${config.maxProfileCharacters}`
	};
	for (const [field, value] of [["userProfile.confirmed", request.userProfile.confirmed], ["userProfile.pendingConfirmation", request.userProfile.pendingConfirmation]]) if (Buffer.byteLength(value, "utf8") > config.maxTextBytes) return {
		code: "text-too-large",
		message: `${field} exceeds ${config.maxTextBytes} bytes`
	};
	if ([...request.userProfile.confirmedEvidenceSeqs, ...request.userProfile.pendingEvidenceSeqs].some((seq) => !Number.isSafeInteger(seq) || seq < 0)) return {
		code: "invalid-document",
		message: "userProfile has an invalid evidence sequence"
	};
	if (request.relationship !== null) {
		for (const field of ["status"]) {
			const invalid = validateText(request.relationship[field], `relationship.${field}`, config.maxTextBytes);
			if (invalid !== void 0) return invalid;
		}
		if (Buffer.byteLength(request.relationship.context, "utf8") > config.maxTextBytes) return {
			code: "text-too-large",
			message: `relationship.context exceeds ${config.maxTextBytes} bytes`
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
		version: 3,
		revision,
		userProfile: {
			confirmed: request.userProfile.confirmed.trim().replace(/^(?:已确认|确认信息)[:：]\s*/u, ""),
			pendingConfirmation: request.userProfile.pendingConfirmation.trim().replace(/^(?:待确认信息|待确认|AI\s*观察|观察)[:：]\s*/iu, ""),
			confirmedEvidenceSeqs: [...request.userProfile.confirmedEvidenceSeqs],
			pendingEvidenceSeqs: [...request.userProfile.pendingEvidenceSeqs]
		},
		preferences: request.preferences.map((item) => ({
			...item,
			category: item.category.trim(),
			text: item.text.trim(),
			evidenceSeqs: [...item.evidenceSeqs]
		})),
		assistantRequirements: request.assistantRequirements.map((item) => ({
			...item,
			category: item.category.trim(),
			text: item.text.trim(),
			evidenceSeqs: [...item.evidenceSeqs]
		})),
		relationship: request.relationship === null ? null : {
			status: request.relationship.status.trim(),
			context: request.relationship.context.trim(),
			updatedAt: request.relationship.updatedAt
		},
		roleplayPreset: request.roleplayPreset === null || request.roleplayPreset.text.trim().length === 0 ? null : {
			enabled: request.roleplayPreset.enabled,
			text: request.roleplayPreset.text.trim()
		},
		updatedAt: time
	};
}
function displayProfile(document) {
	const { confirmed, pendingConfirmation } = document.userProfile;
	return confirmed.length === 0 && pendingConfirmation.length === 0 ? null : `已确认：${confirmed}\n待确认：${pendingConfirmation}`;
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
	for (const section of ["preferences", "assistantRequirements"]) {
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
	let _getCompactionPolicy_decorators;
	let _setCompactionPolicy_decorators;
	return class SessionMemoryService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_get_decorators = [Remote("get")];
			_replace_decorators = [Remote("replace")];
			_getCompactionPolicy_decorators = [Remote("getCompactionPolicy")];
			_setCompactionPolicy_decorators = [Remote("setCompactionPolicy")];
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
			__esDecorate(this, null, _getCompactionPolicy_decorators, {
				kind: "method",
				name: "getCompactionPolicy",
				static: false,
				private: false,
				access: {
					has: (obj) => "getCompactionPolicy" in obj,
					get: (obj) => obj.getCompactionPolicy
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setCompactionPolicy_decorators, {
				kind: "method",
				name: "setCompactionPolicy",
				static: false,
				private: false,
				access: {
					has: (obj) => "setCompactionPolicy" in obj,
					get: (obj) => obj.setCompactionPolicy
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
			"systemPrompt",
			"typert"
		];
		static Config = z.object({
			maxTextBytes: z.number().step(1).min(1).default(4096),
			maxItemsPerSection: z.number().step(1).min(1).max(3).default(3),
			maxProfileCharacters: z.number().step(1).min(1).default(300),
			autoExtract: z.boolean().default(false),
			autoExtractBelowUtilization: z.number().min(0).max(1).default(DEFAULT_AUTO_EXTRACT_BELOW_UTILIZATION),
			extractionMaxTokens: z.number().step(1).min(1).default(6e3)
		});
		resolved = __runInitializers(this, _instanceExtraInitializers);
		installedAgents = /* @__PURE__ */ new WeakSet();
		modelReadState = /* @__PURE__ */ new Map();
		store = new SessionMemorySidecar();
		constructor(ctx, config = {}) {
			super(ctx, "mindspaceSessionMemory");
			ctx.typert.register(TYPERT);
			this.resolved = {
				maxTextBytes: config.maxTextBytes ?? 4096,
				maxItemsPerSection: Math.min(config.maxItemsPerSection ?? 3, 3),
				maxProfileCharacters: config.maxProfileCharacters ?? 300,
				autoExtract: config.autoExtract ?? false,
				autoExtractBelowUtilization: config.autoExtractBelowUtilization ?? .2,
				extractionMaxTokens: config.extractionMaxTokens ?? 6e3
			};
			ctx.systemPrompt.section({
				name: "tool:session-memory",
				order: 113,
				text: MEMORY_TOOL_GUIDANCE
			});
			this.registerTools();
			installSessionCompactionPolicyBridge(ctx, (agent) => this.store.read(agent.session).compactionPolicy);
			ctx.inject(["systemPrompt"], (promptCtx) => {
				for (const agent of ctx.agents.roots()) this.installPrompt(agent);
				promptCtx.on("agent/created", ({ agent }) => {
					if (ctx.agents.roots().includes(agent)) this.installPrompt(agent);
				});
			});
			if (this.resolved.autoExtract) ctx.inject(["llm"], (llmCtx) => {
				llmCtx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
					if (!ctx.agents.roots().includes(agent)) return;
					try {
						const currentView = this.get(agent);
						const current = currentView.document;
						if (sessionMemoryUtilization(current, this.resolved) >= this.resolved.autoExtractBelowUtilization) return;
						if (turnAlreadyWroteSessionMemory(agent.session.events, turn)) return;
						const proposal = await extractTurn(llmCtx, agent, turn, current, this.resolved.extractionMaxTokens, signal);
						if (proposal === void 0) return;
						const sourceSeqs = turnExtractionInput(agent.session.events, turn)?.sourceSeqs ?? [];
						const provisional = mergeExtraction(current, proposal, sourceSeqs, Date.now());
						const overwriteCandidates = provisional.changes.filter((change) => change.operation === "replace" && change.before !== null).map((change) => ({
							section: change.section,
							before: change.before,
							after: change.after
						}));
						const userEvidence = turnExtractionInput(agent.session.events, turn)?.input;
						const approvals = overwriteCandidates.length === 0 ? void 0 : await reviewOverwrites(llmCtx, agent, turn, current, userEvidence ?? "", overwriteCandidates, this.resolved.extractionMaxTokens, signal);
						const merged = overwriteCandidates.length === 0 ? provisional : mergeExtraction(current, proposal, sourceSeqs, Date.now(), { overwriteApprovals: approvals ?? [] });
						if (merged.changes.length === 0) return;
						const validated = resolveDocument({
							expectedRevision: current.revision,
							userProfile: merged.document.userProfile,
							preferences: merged.document.preferences,
							assistantRequirements: merged.document.assistantRequirements,
							relationship: merged.document.relationship,
							roleplayPreset: merged.document.roleplayPreset
						}, merged.document.revision, merged.document.updatedAt, this.resolved);
						if ("code" in validated) {
							ctx.logger.warn(`session-memory extraction rejected for session ${agent.id}: ${validated.message}`);
							return;
						}
						this.store.replace(agent.session, {
							document: validated,
							memoryActivity: [...currentView.memoryActivity, ...merged.changes]
						});
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.logger.warn(`session-memory extraction failed for session ${agent.id}: ${message}`);
					}
				});
			});
		}
		get(agent) {
			this.assertLive(agent);
			return this.store.read(agent.session).view;
		}
		async replace(agent, request) {
			return this.commit(agent, request, []);
		}
		/** Read the compaction policy separately from editable personalization data. */
		getCompactionPolicy(agent) {
			this.assertLive(agent);
			return normalizeCompactionPolicy(this.store.read(agent.session).compactionPolicy);
		}
		/** Persist one session's policy immediately without rewriting its memory document. */
		async setCompactionPolicy(agent, policy) {
			this.assertLive(agent);
			if (!Number.isFinite(policy.thresholdRatio) || policy.thresholdRatio < .05 || policy.thresholdRatio > .8) throw new Error("thresholdRatio must be between 0.05 and 0.8");
			if (!Number.isInteger(policy.retainTokens) || policy.retainTokens < 4096) throw new Error("retainTokens must be an integer >= 4096");
			if (!Number.isInteger(policy.maxTokens) || policy.maxTokens < 512 || policy.maxTokens > 8192) throw new Error("maxTokens must be an integer between 512 and 8192");
			const next = {
				...policy,
				updatedAt: Date.now()
			};
			return this.store.setPolicy(agent.session, next).compactionPolicy;
		}
		async commit(agent, request, sourceSeqs) {
			this.assertLive(agent);
			const currentView = this.get(agent);
			const current = currentView.document;
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
				value: currentView
			};
			const view = {
				document: resolved,
				memoryActivity: [...currentView.memoryActivity, ...changes]
			};
			this.store.replace(agent.session, view);
			return {
				ok: true,
				value: view
			};
		}
		assertLive(agent) {
			if (this.ctx.agents.get(agent.id) !== agent) throw new Error(`session-memory: agent ${agent.id} is not live`);
		}
		registerTools() {
			this.ctx.tools.register(defineTool({
				name: "configure_context_compaction",
				description: "Configure this conversation only: automatic context compaction starts at the chosen share of the routed model context window, preserves the newest tail, and writes a maximum-size editable checkpoint. Use this when the user asks to control context length or compaction. This is not personalization memory and does not alter profile, relationship, or roleplay.",
				parameters: {
					enabled: {
						type: "boolean",
						required: true
					},
					threshold_percent: {
						type: "number",
						description: "5 through 80. At this share of the model context window, automatic compaction begins."
					},
					retain_tokens: {
						type: "number",
						description: "Newest raw context to preserve, at least 4096. Default 64000."
					},
					summary_max_tokens: {
						type: "number",
						description: "Maximum checkpoint size, 512 through 8192. Default 6000."
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
					if (exec.agent === void 0) throw new Error("configure_context_compaction requires an Agent-backed session");
					const percent = args.threshold_percent ?? 16.4;
					const retainTokens = args.retain_tokens ?? 64e3;
					const maxTokens = args.summary_max_tokens ?? 6e3;
					if (!Number.isFinite(percent) || percent < 5 || percent > 80) throw new Error("threshold_percent must be between 5 and 80");
					if (!Number.isInteger(retainTokens) || retainTokens < 4096) throw new Error("retain_tokens must be an integer >= 4096");
					if (!Number.isInteger(maxTokens) || maxTokens < 512 || maxTokens > 8192) throw new Error("summary_max_tokens must be an integer between 512 and 8192");
					const policy = {
						version: 1,
						enabled: args.enabled,
						thresholdRatio: percent / 100,
						retainTokens,
						maxTokens,
						updatedAt: Date.now()
					};
					return await this.setCompactionPolicy(exec.agent, policy);
				}
			}));
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
					const view = this.get(exec.agent);
					const turn = exec.agent.session.events.findLast((event) => event.type === "turn/start")?.data.turn ?? 0;
					this.modelReadState.set(String(exec.agent.id), {
						revision: view.document.revision,
						turn
					});
					return Promise.resolve(view);
				}
			}));
			this.ctx.tools.register(defineTool({
				name: "update_session_memory",
				description: "Persist explicit personalization after calling get_session_memory in this turn. Classify and update the existing state instead of appending duplicates. User profile is user-only confirmed or pending information; preferences are likes, dislikes, topics and habits; assistantRequirements are explicit must/do-not rules; relationship is a revisable current state, never a permanent identity or mission. Roleplay requires explicit user authorship.",
				parameters: {
					action: {
						type: "string",
						required: true,
						enum: [
							"set_user_profile",
							"upsert_item",
							"remove_item",
							"set_relationship_state",
							"clear_relationship",
							"remember_assistant_identity",
							"set_roleplay_preset",
							"clear_roleplay_preset"
						]
					},
					section: {
						type: "string",
						enum: ["preferences", "assistantRequirements"],
						description: "preferences = user likes/dislikes/choices; assistantRequirements = explicit rules for AI replies/actions."
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
					pending_confirmation: {
						type: "string",
						description: "Complete user-related information still awaiting confirmation; revisable and removable."
					},
					relationship_status: {
						type: "string",
						description: "Current revisable relationship state."
					},
					relationship_context: {
						type: "string",
						description: "Concise evidence/context for the current state; not a mission."
					},
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
					const turn = exec.agent.session.events.findLast((event) => event.type === "turn/start")?.data.turn ?? 0;
					const readState = this.modelReadState.get(String(exec.agent.id));
					if (readState?.revision !== current.revision || readState.turn !== turn) throw new Error("Call get_session_memory immediately before update_session_memory so the existing state can be classified and deduplicated.");
					const latestUser = exec.agent.session.events.findLast((event) => event.type === "user/message" && event.data.source.kind === "user");
					const sourceSeqs = latestUser === void 0 ? [] : [latestUser.seq];
					const request = {
						expectedRevision: current.revision,
						userProfile: current.userProfile,
						preferences: [...current.preferences],
						assistantRequirements: [...current.assistantRequirements],
						relationship: current.relationship,
						roleplayPreset: current.roleplayPreset
					};
					if (args.action === "set_user_profile") Object.assign(request, { userProfile: {
						confirmed: args.confirmed ?? current.userProfile.confirmed,
						pendingConfirmation: args.pending_confirmation ?? current.userProfile.pendingConfirmation,
						confirmedEvidenceSeqs: args.confirmed === void 0 ? [...current.userProfile.confirmedEvidenceSeqs] : [.../* @__PURE__ */ new Set([...current.userProfile.confirmedEvidenceSeqs, ...sourceSeqs])],
						pendingEvidenceSeqs: args.pending_confirmation === void 0 ? [...current.userProfile.pendingEvidenceSeqs] : [.../* @__PURE__ */ new Set([...current.userProfile.pendingEvidenceSeqs, ...sourceSeqs])]
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
					} else if (args.action === "set_relationship_state") {
						if (args.relationship_status === void 0 || args.relationship_status.trim().length === 0) throw new Error("relationship_status is required");
						Object.assign(request, { relationship: {
							status: args.relationship_status,
							context: args.relationship_context ?? "",
							updatedAt: Date.now()
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
					} else if (args.action === "clear_roleplay_preset") Object.assign(request, { roleplayPreset: null });
					else throw new Error(`Unsupported memory action: ${String(args.action)}`);
					const result = await this.commit(exec.agent, request, sourceSeqs);
					if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
					this.modelReadState.delete(String(exec.agent.id));
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
					const view = this.get(agent);
					const onboarding = agent.session.events.filter((event) => event.type === "turn/start").length === 1 && isEmptyDocument(view.document) ? `\n\n${NEW_SESSION_ONBOARDING}` : "";
					return `${renderSessionMemory(view)}${onboarding}`;
				}
			});
		}
	};
})();
//#endregion
export { migrateLegacyDocument as _, DEFAULT_PROFILE_CHARACTERS as a, mergeExtraction as c, reviewOverwrites as d, turnExtractionInput as f, foldSessionMemory as g, emptySessionMemoryFoldState as h, renderSessionMemory as i, parseExtraction as l, emptySessionMemory as m, DEFAULT_AUTO_EXTRACT_BELOW_UTILIZATION as n, EXTRACTION_SYSTEM as o, applySessionMemoryEvent as p, sessionMemoryUtilization as r, MAX_MEMORY_CARDS as s, SessionMemoryService as t, parseOverwriteReview as u, sessionMemoryView as v };
