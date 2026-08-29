import { TYPERT } from "./typert.js";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { PERSONA_ORDER, PERSONA_SECTION } from "@deepseek-ai/dsh-system-prompt";
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
function normalizeCompactionPolicy(value) {
	const candidate = value !== null && typeof value === "object" ? value : {};
	return {
		enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : DEFAULT_COMPACTION_POLICY.enabled,
		thresholdRatio: Number.isFinite(candidate.thresholdRatio) && candidate.thresholdRatio >= .05 && candidate.thresholdRatio <= .8 ? candidate.thresholdRatio : DEFAULT_COMPACTION_POLICY.thresholdRatio,
		retainTokens: Number.isInteger(candidate.retainTokens) && candidate.retainTokens >= 4096 ? candidate.retainTokens : DEFAULT_COMPACTION_POLICY.retainTokens,
		maxTokens: Number.isInteger(candidate.maxTokens) && candidate.maxTokens >= 512 && candidate.maxTokens <= 8192 ? candidate.maxTokens : DEFAULT_COMPACTION_POLICY.maxTokens,
		updatedAt: Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : 0
	};
}
function emptySessionMemory() {
	return {
		version: 4,
		revision: 0,
		people: [],
		assistantRequirements: [],
		memories: [],
		updatedAt: 0
	};
}
function mergeText(current, incoming) {
	const left = current.trim();
	const right = incoming.trim();
	if (left.length === 0) return right;
	if (right.length === 0 || left.includes(right)) return left;
	if (right.includes(left)) return right;
	return `${left}；${right}`;
}
function normalizeMemoryCards(items, fallbackCategory, limit = 3) {
	const result = [];
	const categories = /* @__PURE__ */ new Map();
	for (const [index, item] of items.entries()) {
		const category = item.category.trim() || fallbackCategory;
		const text = item.text.trim();
		if (text.length === 0) continue;
		const key = category.toLocaleLowerCase();
		const duplicate = categories.get(key);
		if (duplicate !== void 0) {
			const current = result[duplicate];
			result[duplicate] = {
				...current,
				text: mergeText(current.text, text),
				source: current.source === "user" || item.source === "user" ? "user" : "extracted",
				evidenceSeqs: [.../* @__PURE__ */ new Set([...current.evidenceSeqs, ...item.evidenceSeqs])]
			};
			continue;
		}
		categories.set(key, result.length);
		result.push({
			...item,
			id: item.id.trim() || `replayed-${fallbackCategory}-${index}`,
			category,
			text,
			evidenceSeqs: [...new Set(item.evidenceSeqs)]
		});
	}
	while (result.length > limit) {
		const overflow = result.pop();
		const target = result[result.length - 1];
		result[result.length - 1] = {
			...target,
			category: `${target.category} / ${overflow.category}`,
			text: mergeText(target.text, `${overflow.category}：${overflow.text}`),
			evidenceSeqs: [.../* @__PURE__ */ new Set([...target.evidenceSeqs, ...overflow.evidenceSeqs])]
		};
	}
	return result;
}
function normalizePeople(people) {
	const result = [];
	const ids = /* @__PURE__ */ new Set();
	for (const [index, person] of people.entries()) {
		const id = person.id.trim() || `person-${index + 1}`;
		if (ids.has(id)) continue;
		ids.add(id);
		result.push({
			...person,
			id,
			name: person.name.trim() || `人物${index + 1}`,
			information: person.information.trim(),
			preference: person.preference.trim(),
			relationship: person.relationship.trim(),
			evidenceSeqs: [...new Set(person.evidenceSeqs)],
			updatedAt: Number.isFinite(person.updatedAt) ? person.updatedAt : 0
		});
		if (result.length === 5) break;
	}
	return result;
}
function normalizeSessionMemoryDocument(document) {
	return {
		...document,
		version: 4,
		people: normalizePeople(document.people),
		assistantRequirements: normalizeMemoryCards(document.assistantRequirements, "对AI的要求"),
		memories: normalizeMemoryCards(document.memories, "记忆")
	};
}
function legacyCard(item, category) {
	return {
		...item,
		category,
		evidenceSeqs: [...item.evidenceSeqs]
	};
}
function legacyCards(items, fallback) {
	return normalizeMemoryCards(items.map((item) => ({
		...item,
		evidenceSeqs: [...item.evidenceSeqs]
	})), fallback);
}
function preferenceText(items) {
	return items.map((item) => `${item.category.trim() || "偏好"}：${item.text.trim()}`).filter((value) => !value.endsWith("：")).join("；");
}
function relationshipText(relationship) {
	if (relationship === null) return "";
	return [relationship.status.trim() ? `状态：${relationship.status.trim()}` : "", relationship.context.trim() ? `背景：${relationship.context.trim()}` : ""].filter(Boolean).join("；");
}
/** V3 -> V4: the former single user becomes unnamed person one without losing text. */
function migrateV3Document(document) {
	const information = [document.userProfile.confirmed.trim(), document.userProfile.pendingConfirmation.trim()].filter(Boolean).join("；");
	const preference = preferenceText(document.preferences);
	const relationship = relationshipText(document.relationship);
	const evidenceSeqs = [.../* @__PURE__ */ new Set([
		...document.userProfile.confirmedEvidenceSeqs,
		...document.userProfile.pendingEvidenceSeqs,
		...document.preferences.flatMap((item) => item.evidenceSeqs)
	])];
	const people = [
		information,
		preference,
		relationship
	].some(Boolean) ? [{
		id: "migrated-person-1",
		name: "人物一",
		information,
		preference,
		relationship,
		source: document.preferences.some((item) => item.source === "extracted") ? "extracted" : "user",
		evidenceSeqs,
		updatedAt: -1
	}] : [];
	const memories = document.roleplayPreset?.text.trim() ? [{
		id: "memory-migrated-roleplay",
		category: "既有记忆",
		text: document.roleplayPreset.text.trim(),
		source: "user",
		evidenceSeqs: []
	}] : [];
	return normalizeSessionMemoryDocument({
		version: 4,
		revision: document.revision,
		people,
		assistantRequirements: legacyCards(document.assistantRequirements, "对AI的要求"),
		memories,
		updatedAt: document.updatedAt
	});
}
function v2Relationship(document) {
	if (document.relationship === null) return null;
	const context = [document.relationship.guidance.trim(), document.relationship.mission.trim() ? `历史背景：${document.relationship.mission.trim()}` : ""].filter(Boolean).join("；");
	return {
		status: document.relationship.role.trim(),
		context,
		updatedAt: document.updatedAt
	};
}
function migrateV2Document(document) {
	return migrateV3Document({
		version: 3,
		revision: document.revision,
		userProfile: {
			confirmed: document.userProfile.confirmed,
			pendingConfirmation: document.userProfile.inferred,
			confirmedEvidenceSeqs: [...document.userProfile.evidenceSeqs],
			pendingEvidenceSeqs: [...document.userProfile.evidenceSeqs]
		},
		preferences: document.preferences,
		assistantRequirements: document.assistantInstructions,
		relationship: v2Relationship(document),
		roleplayPreset: document.roleplayPreset,
		updatedAt: document.updatedAt
	});
}
function migrateLegacyDocument(document) {
	const facts = document.userFacts.map((item) => item.text.trim()).filter(Boolean).join("；");
	return migrateV2Document({
		version: 2,
		revision: document.revision,
		userProfile: {
			confirmed: facts,
			inferred: "",
			evidenceSeqs: [...new Set(document.userFacts.flatMap((item) => item.evidenceSeqs))]
		},
		preferences: document.preferences.map((item) => legacyCard(item, "综合偏好")),
		assistantInstructions: document.assistantInstructions.map((item) => legacyCard(item, "对AI的要求")),
		relationship: document.relationship,
		roleplayPreset: document.roleplayPreset ?? null,
		updatedAt: document.updatedAt
	});
}
function migrateActivity$1(activity) {
	if (activity === null || typeof activity !== "object") return void 0;
	const row = activity;
	const oldSection = String(row["section"] ?? "");
	const section = oldSection === "assistantRequirements" || oldSection === "assistantInstructions" ? "assistantRequirements" : oldSection === "roleplayPreset" ? "memories" : "people";
	return {
		...row,
		section
	};
}
function emptySessionMemoryFoldState() {
	return {
		document: emptySessionMemory(),
		memoryActivity: [],
		compactionPolicy: DEFAULT_COMPACTION_POLICY
	};
}
function applySessionMemoryEvent(state, event) {
	if (event.type === "mindspace-compaction/policy") {
		const value = event.data;
		if (value !== null && typeof value === "object") return {
			...state,
			compactionPolicy: normalizeCompactionPolicy(value)
		};
	}
	if (event.type !== "session-memory/change") return state;
	const version = event.data.version;
	const document = version === 1 ? migrateLegacyDocument(event.data.document) : version === 2 ? migrateV2Document(event.data.document) : version === 3 ? migrateV3Document(event.data.document) : normalizeSessionMemoryDocument(event.data.document);
	const changes = "changes" in event.data ? event.data.changes.map(migrateActivity$1).filter((item) => item !== void 0) : [];
	return {
		...state,
		document,
		memoryActivity: [...state.memoryActivity, ...changes]
	};
}
function sessionMemoryView(state) {
	return {
		document: state.document,
		memoryActivity: state.memoryActivity
	};
}
function foldCompactionPolicy(events) {
	let state = emptySessionMemoryFoldState();
	for (const event of events) state = applySessionMemoryEvent(state, event);
	return normalizeCompactionPolicy(state.compactionPolicy);
}
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
/** Durable per-session storage outside DSH's canonical conversation event log. */
function dshHome() {
	return process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
}
function sessionFilename(id) {
	return `${createHash("sha256").update(id).digest("hex")}.json`;
}
function storedBase(value, sessionId, format) {
	if (value === null || typeof value !== "object") return false;
	const row = value;
	return row["format"] === format && row["sessionId"] === sessionId && row["view"] !== null && typeof row["view"] === "object" && row["compactionPolicy"] !== null && typeof row["compactionPolicy"] === "object";
}
function isStored(value, sessionId) {
	return storedBase(value, sessionId, 4);
}
function isStoredV3(value, sessionId) {
	return storedBase(value, sessionId, 3);
}
function isStoredV2(value, sessionId) {
	return storedBase(value, sessionId, 2);
}
function migrateActivity(value) {
	if (value === null || typeof value !== "object") return void 0;
	const row = value;
	const oldSection = String(row["section"] ?? "");
	const section = oldSection === "assistantRequirements" || oldSection === "assistantInstructions" ? "assistantRequirements" : oldSection === "roleplayPreset" ? "memories" : "people";
	return {
		...row,
		section
	};
}
function legacyMemoryView(events) {
	const preferences = [];
	const requirements = [];
	let relationship = null;
	let lastSeq = -1;
	for (const raw of events) {
		if (raw === null || typeof raw !== "object") continue;
		const event = raw;
		if (typeof event.type !== "string" || !event.type.startsWith("memory/") || event.data === null || typeof event.data !== "object") continue;
		const data = event.data;
		lastSeq = typeof event.seq === "number" ? event.seq : lastSeq;
		if (event.type === "memory/set") {
			const slot = data.slot;
			const target = slot === "preferences" ? preferences : slot === "instructions" ? requirements : void 0;
			const text = typeof data.text === "string" ? data.text.trim() : "";
			if (target === void 0 || text === "") continue;
			const id = typeof data.id === "string" && data.id.trim() ? data.id : `legacy-${slot}-${lastSeq}`;
			const next = {
				id,
				category: typeof data.category === "string" && data.category.trim() ? data.category : slot === "preferences" ? "综合偏好" : "对AI的要求",
				text,
				source: data.source === "extracted" ? "extracted" : "user",
				evidenceSeqs: typeof data.evidenceSeq === "number" ? [data.evidenceSeq] : []
			};
			const at = target.findIndex((item) => item.id === id);
			if (at >= 0) target.splice(at, 1, next);
			else target.push(next);
		} else if (event.type === "memory/remove" && typeof data.id === "string") {
			const target = data.slot === "preferences" ? preferences : data.slot === "instructions" ? requirements : void 0;
			if (target !== void 0) {
				const at = target.findIndex((item) => item.id === data.id);
				if (at >= 0) target.splice(at, 1);
			}
		} else if (event.type === "memory/relationship") {
			const status = typeof data.role === "string" ? data.role.trim() : "";
			if (status) relationship = {
				status,
				context: [typeof data.personaText === "string" ? data.personaText.trim() : "", typeof data.mission === "string" && data.mission.trim() ? `历史背景：${data.mission.trim()}` : ""].filter(Boolean).join("；"),
				updatedAt: Date.now()
			};
		}
	}
	if (lastSeq < 0) return {
		view: {
			document: emptySessionMemory(),
			memoryActivity: []
		},
		lastSeq
	};
	return {
		view: {
			document: migrateV3Document({
				version: 3,
				revision: 1,
				userProfile: {
					confirmed: "",
					pendingConfirmation: "",
					confirmedEvidenceSeqs: [],
					pendingEvidenceSeqs: []
				},
				preferences,
				assistantRequirements: requirements,
				relationship,
				roleplayPreset: null,
				updatedAt: Date.now()
			}),
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
			if (isStoredV3(parsed, session.id) || isStoredV2(parsed, session.id)) {
				const document = parsed.format === 3 ? migrateV3Document(parsed.view.document) : migrateV2Document(parsed.view.document);
				const migrated = {
					format: 4,
					sessionId: session.id,
					view: {
						document,
						memoryActivity: parsed.view.memoryActivity.map(migrateActivity).filter((item) => item !== void 0)
					},
					compactionPolicy: normalizeCompactionPolicy(parsed.compactionPolicy),
					writtenAt: Date.now()
				};
				this.write(migrated);
				return migrated;
			}
		} catch {}
		const imported = {
			format: 4,
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
const MAX_MEMORY_CARDS = 3;
const DEFAULT_PROFILE_CHARACTERS = 300;
const EXTRACTION_SYSTEM = [
	"Consolidate durable information from the newest direct message into the COMPLETE current session memory.",
	"Return JSON only with keys people, assistantRequirements, memories, atoms.",
	"people is a complete ordered array of at most 5 people. The first person usually corresponds to the current speaker,",
	"but never describe that person as the only user, owner, principal, or the whole world. Each person is",
	"{id,name,information,preference,relationship}. Keep an existing id when updating or renaming that person; omit id only",
	"for a genuinely new person. information and preference are each at most 300 Unicode characters. relationship describes",
	"that person’s current relationship and background with the active AI. A parent, friend, colleague, or another AI may be",
	"added when the direct message provides durable identifying information. Do not create people for organizations, products,",
	"or generic groups. Same-name people may coexist; never merge by name alone. Preserve every unaffected person and field.",
	"assistantRequirements is a complete array of at most 3 {category,text} cards containing explicit must, should, do-not,",
	"or stable interaction rules addressed to the AI. memories is a complete array of at most 3 {category,text} ordinary",
	"memories worth carrying forward; it is not a roleplay-only preset and has no enabled switch.",
	"A newer explicit correction may replace conflicting content. Do not invent facts or erase unrelated information.",
	"atoms is a compact audit list of actual durable updates: {text,disposition:\"handled\"|\"skipped\",section,reason}.",
	"section is people, assistantRequirements, memories, or null. Return [] when nothing durable changed. Emit JSON only."
].join(" ");
const OVERWRITE_REVIEW_SYSTEM = [
	"Review proposed destructive changes to multi-person session memory. Return JSON only as",
	"{\"decisions\":[{\"section\":\"...\",\"before\":\"...\",\"after\":\"...\"|null,\"approved\":true|false,\"reason\":\"...\"}]}.",
	"Approve only when the newest direct evidence explicitly corrects, supersedes, withdraws, or removes the exact prior",
	"person/card. New detail must not erase unrelated information. Account for every supplied candidate exactly once."
].join(" ");
function clean(value) {
	return typeof value === "string" ? value.trim() : void 0;
}
function parseCards(value) {
	if (!Array.isArray(value) || value.length > 3) return void 0;
	const result = [];
	for (const item of value) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) return void 0;
		const row = item;
		const category = clean(row["category"]);
		const text = clean(row["text"]);
		if (!category || !text) return void 0;
		result.push({
			category,
			text
		});
	}
	return result;
}
function parsePeople(value) {
	if (!Array.isArray(value) || value.length > 5) return void 0;
	const ids = /* @__PURE__ */ new Set();
	const result = [];
	for (const item of value) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) return void 0;
		const row = item;
		const id = clean(row["id"]);
		const name = clean(row["name"]);
		const information = clean(row["information"]);
		const preference = clean(row["preference"]);
		const relationship = clean(row["relationship"]);
		if (!name || information === void 0 || preference === void 0 || relationship === void 0) return void 0;
		if ([...information].length > 300 || [...preference].length > 300) return void 0;
		if (id) {
			if (ids.has(id)) return void 0;
			ids.add(id);
		}
		result.push({
			...id ? { id } : {},
			name,
			information,
			preference,
			relationship
		});
	}
	return result;
}
function parseAtoms(value) {
	if (!Array.isArray(value) || value.length > 24) return void 0;
	const sections = /* @__PURE__ */ new Set([
		"people",
		"assistantRequirements",
		"memories"
	]);
	const result = [];
	for (const item of value) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) return void 0;
		const row = item;
		const text = clean(row["text"]);
		const reason = clean(row["reason"]);
		const section = row["section"];
		if (!text || !reason || row["disposition"] !== "handled" && row["disposition"] !== "skipped") return void 0;
		if (section !== null && (typeof section !== "string" || !sections.has(section))) return void 0;
		result.push({
			text,
			reason,
			disposition: row["disposition"],
			section
		});
	}
	return result;
}
function parseExtraction(text) {
	try {
		const value = JSON.parse(text);
		if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
		const row = value;
		const people = parsePeople(row["people"]);
		const assistantRequirements = parseCards(row["assistantRequirements"]);
		const memories = parseCards(row["memories"]);
		const atoms = parseAtoms(row["atoms"]);
		return people && assistantRequirements && memories && atoms ? {
			people,
			assistantRequirements,
			memories,
			atoms
		} : void 0;
	} catch {
		return;
	}
}
function overwriteKey(value) {
	return JSON.stringify([
		value.section,
		value.before,
		value.after
	]);
}
function parseOverwriteReview(text, candidates) {
	try {
		const value = JSON.parse(text);
		if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
		const rows = value["decisions"];
		if (!Array.isArray(rows) || rows.length !== candidates.length) return void 0;
		const expected = new Set(candidates.map(overwriteKey));
		const sections = /* @__PURE__ */ new Set([
			"people",
			"assistantRequirements",
			"memories"
		]);
		const result = [];
		for (const item of rows) {
			if (item === null || typeof item !== "object" || Array.isArray(item)) return void 0;
			const row = item;
			const section = clean(row["section"]);
			const before = clean(row["before"]);
			const after = row["after"] === null ? null : clean(row["after"]);
			const reason = clean(row["reason"]);
			if (!section || !sections.has(section) || before === void 0 || after === void 0 || !reason || typeof row["approved"] !== "boolean") return void 0;
			const decision = {
				section,
				before,
				after,
				reason,
				approved: row["approved"]
			};
			if (!expected.delete(overwriteKey(decision))) return void 0;
			result.push(decision);
		}
		return expected.size === 0 ? result : void 0;
	} catch {
		return;
	}
}
async function reviewOverwrites(ctx, agent, turn, current, directEvidence, candidates, maxTokens, signal) {
	if (candidates.length === 0) return [];
	const route = agent.session.requestHeader()?.config;
	if (!route) return void 0;
	const { BlockAssembler, createUserMessage, deepFreeze } = await import("@deepseek-ai/dsh-llm");
	const assembler = new BlockAssembler();
	const request = deepFreeze({
		provider: route.provider,
		model: route.model,
		messages: [createUserMessage({
			content: [{
				type: "text",
				text: JSON.stringify({
					turn,
					newestDirectEvidence: directEvidence,
					currentMemory: current,
					candidateOverwrites: candidates
				})
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
function objectText(value) {
	return value === null || value === void 0 ? null : JSON.stringify(value);
}
function operation(before, after) {
	if (before === null) return "append";
	if (after === null) return "replace";
	return normalized(after).includes(normalized(before)) ? "merge" : "replace";
}
function activity(section, before, after, sourceSeqs, time, reason, op = operation(before, after)) {
	return {
		id: `activity-${randomUUID()}`,
		sourceSeqs: [...sourceSeqs],
		operation: op,
		section,
		before,
		after,
		reason,
		at: time
	};
}
function decision(approvals, section, before, after) {
	if (approvals === void 0) return {
		section,
		before,
		after,
		approved: true,
		reason: "Initial provisional merge."
	};
	return approvals.find((value) => value.section === section && value.before === before && value.after === after);
}
function reconcileCards(section, current, proposed, evidenceSeqs, time, approvals) {
	const remaining = [...current];
	const items = [];
	const changes = [];
	for (const card of proposed) {
		const at = remaining.findIndex((item) => normalized(item.category) === normalized(card.category));
		const previous = at >= 0 ? remaining.splice(at, 1)[0] : void 0;
		const next = previous && normalized(previous.text) === normalized(card.text) ? previous : {
			id: previous?.id ?? `memory-${randomUUID()}`,
			category: card.category,
			text: card.text,
			source: "extracted",
			evidenceSeqs: [.../* @__PURE__ */ new Set([...previous?.evidenceSeqs ?? [], ...evidenceSeqs])]
		};
		const before = objectText(previous);
		const after = objectText(next);
		if (before !== after) {
			if (!(before === null || decision(approvals, section, before, after)?.approved === true)) {
				items.push(previous);
				changes.push(activity(section, before, after, evidenceSeqs, time, "Preserved because overwrite review did not approve the change.", "skip"));
				continue;
			}
			changes.push(activity(section, before, after, evidenceSeqs, time, previous ? "Updated from direct evidence." : "Added from direct evidence."));
		}
		items.push(next);
	}
	for (const previous of remaining) {
		const before = objectText(previous);
		if (!(decision(approvals, section, before, null)?.approved === true)) {
			items.push(previous);
			changes.push(activity(section, before, null, evidenceSeqs, time, "Preserved because deletion review did not approve omission.", "skip"));
		} else changes.push(activity(section, before, null, evidenceSeqs, time, "Removed after explicit correction."));
	}
	return {
		items: items.slice(0, 3),
		changes
	};
}
function reconcilePeople(current, proposed, evidenceSeqs, time, approvals) {
	const remaining = [...current];
	const people = [];
	const changes = [];
	for (const row of proposed.slice(0, 5)) {
		const at = row.id ? remaining.findIndex((person) => person.id === row.id) : -1;
		const previous = at >= 0 ? remaining.splice(at, 1)[0] : void 0;
		const next = previous && [
			previous.name,
			previous.information,
			previous.preference,
			previous.relationship
		].every((value, index) => normalized(value) === normalized([
			row.name,
			row.information,
			row.preference,
			row.relationship
		][index])) ? previous : {
			id: previous?.id ?? `person-${randomUUID()}`,
			name: row.name,
			information: row.information,
			preference: row.preference,
			relationship: row.relationship,
			source: "extracted",
			evidenceSeqs: [.../* @__PURE__ */ new Set([...previous?.evidenceSeqs ?? [], ...evidenceSeqs])],
			updatedAt: time
		};
		const before = objectText(previous);
		const after = objectText(next);
		if (before !== after) {
			if (!(before === null || decision(approvals, "people", before, after)?.approved === true)) {
				people.push(previous);
				changes.push(activity("people", before, after, evidenceSeqs, time, "Preserved because overwrite review did not approve the person change.", "skip"));
				continue;
			}
			changes.push(activity("people", before, after, evidenceSeqs, time, previous ? "Updated a represented person from direct evidence." : "Added a represented person from direct evidence."));
		}
		people.push(next);
	}
	for (const previous of remaining) {
		const before = objectText(previous);
		if (decision(approvals, "people", before, null)?.approved === true) changes.push(activity("people", before, null, evidenceSeqs, time, "Removed after explicit correction."));
		else {
			people.push(previous);
			changes.push(activity("people", before, null, evidenceSeqs, time, "Preserved because deletion review did not approve omission.", "skip"));
		}
	}
	return {
		people: people.slice(0, 5),
		changes
	};
}
function mergeExtraction(document, proposal, evidenceSeqs, time, options = {}) {
	const approvals = options.overwriteApprovals;
	const people = reconcilePeople(document.people, proposal.people, evidenceSeqs, time, approvals);
	const requirements = reconcileCards("assistantRequirements", document.assistantRequirements, proposal.assistantRequirements, evidenceSeqs, time, approvals);
	const memories = reconcileCards("memories", document.memories, proposal.memories, evidenceSeqs, time, approvals);
	const changes = [
		...people.changes,
		...requirements.changes,
		...memories.changes
	];
	const changed = changes.some((change) => change.operation !== "skip");
	for (const atom of proposal.atoms) if (atom.disposition === "skipped") changes.push(activity(atom.section ?? "people", null, null, evidenceSeqs, time, atom.reason, "skip"));
	return {
		document: {
			version: 4,
			revision: changed ? document.revision + 1 : document.revision,
			people: people.people,
			assistantRequirements: requirements.items,
			memories: memories.items,
			updatedAt: changed ? time : document.updatedAt
		},
		changes
	};
}
function turnExtractionInput(events, turn) {
	const start = events.findLastIndex((event) => event.type === "turn/start" && event.data.turn === turn);
	if (start < 0) return void 0;
	const rows = [];
	const sourceSeqs = [];
	for (const event of events.slice(start + 1)) {
		if (event.type === "turn/start" || event.type === "turn/end" && event.data.turn === turn) break;
		if (event.type === "user/message" && event.data.source.kind === "user") {
			rows.push(`DIRECT_MESSAGE:\n${event.data.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")}`);
			sourceSeqs.push(event.seq);
		}
	}
	return sourceSeqs.length ? {
		input: rows.join("\n\n"),
		sourceSeqs
	} : void 0;
}
async function extractTurn(ctx, agent, turn, current, maxTokens, signal) {
	const input = turnExtractionInput(agent.session.events, turn);
	const route = agent.session.requestHeader()?.config;
	if (!input || !route) return void 0;
	const { BlockAssembler, createUserMessage, deepFreeze } = await import("@deepseek-ai/dsh-llm");
	const assembler = new BlockAssembler();
	const request = deepFreeze({
		provider: route.provider,
		model: route.model,
		messages: [createUserMessage({
			content: [{
				type: "text",
				text: `${input.input}\n\nCURRENT_SESSION_MEMORY:\n${JSON.stringify(current)}`
			}],
			source: {
				kind: "plugin",
				plugin: "dsh-session-memory-governance"
			}
		})],
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
const numerals = [
	"一",
	"二",
	"三",
	"四",
	"五"
];
function cards(label, values) {
	return values.length === 0 ? "" : `${label}：\n${values.map((value) => `- ${value.category}：${value.text}`).join("\n")}`;
}
/** The session-owned persona. Empty requirements deliberately mean no persona. */
function renderAssistantRequirements(view) {
	return cards("对 AI 的要求", view.document.assistantRequirements);
}
/** People and ordinary memories are context, not identity or standing orders. */
function renderSessionMemoryContext(view) {
	const { document } = view;
	const people = document.people.map((person, index) => [
		`人物${numerals[index] ?? index + 1}`,
		`个体名称：${person.name}`,
		person.information ? `个体信息：${person.information}` : "",
		person.preference ? `人物偏好：${person.preference}` : "",
		person.relationship ? `与当前 AI 的关系及背景：${person.relationship}` : ""
	].filter(Boolean).join("\n")).join("\n\n");
	return [people ? `这段对话中存在以下人物。人物一对应当前发言者；其他人物同样构成这个世界并可能影响当前判断。\n\n人物信息：\n${people}` : "", cards("记忆", document.memories)].filter(Boolean).join("\n\n");
}
/** Full model-facing Memory text, retained as a public rendering helper. */
function renderSessionMemory(view) {
	return [renderAssistantRequirements(view), renderSessionMemoryContext(view)].filter(Boolean).join("\n\n");
}
//#endregion
//#region src/memory/usage.ts
/** Capacity accounting for the editable multi-person memory document. */
const DEFAULT_AUTO_EXTRACT_BELOW_UTILIZATION = .2;
function sessionMemoryUtilization(document, limits) {
	const bytes = (text) => Buffer.byteLength(text, "utf8");
	const used = document.people.reduce((total, person) => total + bytes(person.name) + bytes(person.information) + bytes(person.preference) + bytes(person.relationship), 0) + document.assistantRequirements.reduce((total, item) => total + bytes(item.category) + bytes(item.text), 0) + document.memories.reduce((total, item) => total + bytes(item.category) + bytes(item.text), 0);
	const capacity = 5 * limits.maxProfileCharacters * 8 + limits.maxItemsPerSection * limits.maxTextBytes * 2;
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
const personSchema = z$1.object({
	id: z$1.string(),
	name: z$1.string(),
	information: z$1.string(),
	preference: z$1.string(),
	relationship: z$1.string(),
	source: z$1.enum(["user", "extracted"]),
	evidenceSeqs: z$1.array(z$1.number()),
	updatedAt: z$1.number()
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
		"people",
		"assistantRequirements",
		"memories"
	]),
	before: z$1.string().nullable(),
	after: z$1.string().nullable(),
	reason: z$1.string(),
	at: z$1.number()
});
const documentSchema = z$1.object({
	version: z$1.literal(4),
	revision: z$1.number(),
	people: z$1.array(personSchema),
	assistantRequirements: z$1.array(memoryItemSchema),
	memories: z$1.array(memoryItemSchema),
	updatedAt: z$1.number()
});
z$1.object({
	document: documentSchema,
	memoryActivity: z$1.array(activitySchema)
});
const MEMORY_TOOL_GUIDANCE = [
	"Session memory represents multiple people in this conversation world. Before every write, call get_session_memory.",
	"The ordered people list contains at most five people. Person one corresponds to the current speaker, but is not the only",
	"person who may matter. Keep stable person ids; never merge people by name alone. For each person store a name, durable",
	"information, one concise preference, and that person’s current relationship/background with the active AI. Information",
	"and preference are each limited to 300 Unicode characters. assistantRequirements contains only explicit must, should,",
	"do-not, prohibition, or stable interaction rules addressed to the AI. memories contains up to three ordinary memory",
	"groups worth carrying forward; it is not a roleplay preset and has no enabled switch. Update the matching person/card",
	"instead of appending duplicates. Never invent people or facts. These tools affect only this session."
].join(" ");
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
	for (const [field, items] of [["assistantRequirements", request.assistantRequirements], ["memories", request.memories]]) {
		const invalid = validateItems(items, field, config);
		if (invalid !== void 0) return invalid;
	}
	if (request.people.length > 5) return {
		code: "invalid-document",
		message: `people has ${request.people.length} entries; limit is 5`
	};
	const personIds = /* @__PURE__ */ new Set();
	for (const [index, person] of request.people.entries()) {
		for (const [field, value] of [["id", person.id], ["name", person.name]]) {
			const invalid = validateText(value, `people[${index}].${field}`, config.maxTextBytes);
			if (invalid !== void 0) return invalid;
		}
		if (personIds.has(person.id)) return {
			code: "invalid-document",
			message: `people repeats person id ${JSON.stringify(person.id)}`
		};
		personIds.add(person.id);
		for (const [field, value] of [
			["information", person.information],
			["preference", person.preference],
			["relationship", person.relationship]
		]) if (Buffer.byteLength(value, "utf8") > config.maxTextBytes) return {
			code: "text-too-large",
			message: `people[${index}].${field} exceeds ${config.maxTextBytes} bytes`
		};
		const isUnchangedLegacy = person.updatedAt <= 0;
		if (!isUnchangedLegacy && [...person.information].length > config.maxProfileCharacters) return {
			code: "text-too-large",
			message: `people[${index}].information exceeds ${config.maxProfileCharacters} characters`
		};
		if (!isUnchangedLegacy && [...person.preference].length > config.maxProfileCharacters) return {
			code: "text-too-large",
			message: `people[${index}].preference exceeds ${config.maxProfileCharacters} characters`
		};
		if (person.evidenceSeqs.some((seq) => !Number.isSafeInteger(seq) || seq < 0)) return {
			code: "invalid-document",
			message: `people[${index}] has an invalid evidence sequence`
		};
	}
	return {
		version: 4,
		revision,
		people: request.people.map((person) => ({
			...person,
			name: person.name.trim(),
			information: person.information.trim(),
			preference: person.preference.trim(),
			relationship: person.relationship.trim(),
			evidenceSeqs: [...person.evidenceSeqs]
		})),
		assistantRequirements: request.assistantRequirements.map((item) => ({
			...item,
			category: item.category.trim(),
			text: item.text.trim(),
			evidenceSeqs: [...item.evidenceSeqs]
		})),
		memories: request.memories.map((item) => ({
			...item,
			category: item.category.trim(),
			text: item.text.trim(),
			evidenceSeqs: [...item.evidenceSeqs]
		})),
		updatedAt: time
	};
}
function displayPerson(person) {
	return person === void 0 ? null : JSON.stringify(person);
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
	const personIds = /* @__PURE__ */ new Set([...current.people.map((person) => person.id), ...next.people.map((person) => person.id)]);
	for (const id of personIds) {
		const before = displayPerson(current.people.find((person) => person.id === id));
		const after = displayPerson(next.people.find((person) => person.id === id));
		if (before !== after) changes.push(makeActivity("people", before, after, time, sourceSeqs));
	}
	for (const section of ["assistantRequirements", "memories"]) {
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
							people: merged.document.people,
							assistantRequirements: merged.document.assistantRequirements,
							memories: merged.document.memories
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
				description: "Read the current ordered people, AI requirements, ordinary memories, and change activity for this session.",
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
				description: "Persist multi-person session memory after calling get_session_memory in this turn. Keep person ids stable; person one corresponds to the current speaker but is not the only represented person. Update existing entries instead of duplicating them.",
				parameters: {
					action: {
						type: "string",
						required: true,
						enum: [
							"add_person",
							"update_person",
							"remove_person",
							"upsert_item",
							"remove_item"
						]
					},
					section: {
						type: "string",
						enum: ["assistantRequirements", "memories"],
						description: "assistantRequirements = explicit rules for AI replies/actions; memories = ordinary remembered events or context."
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
					person_id: {
						type: "string",
						description: "Stable id returned by get_session_memory; required for update/remove."
					},
					person_name: {
						type: "string",
						description: "Person name; required when adding and optional when updating."
					},
					information: {
						type: "string",
						description: "Complete durable information for this person, up to 300 characters."
					},
					preference: {
						type: "string",
						description: "One consolidated preference text for this person, up to 300 characters."
					},
					relationship: {
						type: "string",
						description: "This person’s current relationship and background with the active AI."
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
					const turn = exec.agent.session.events.findLast((event) => event.type === "turn/start")?.data.turn ?? 0;
					const readState = this.modelReadState.get(String(exec.agent.id));
					if (readState?.revision !== current.revision || readState.turn !== turn) throw new Error("Call get_session_memory immediately before update_session_memory so the existing state can be classified and deduplicated.");
					const latestUser = exec.agent.session.events.findLast((event) => event.type === "user/message" && event.data.source.kind === "user");
					const sourceSeqs = latestUser === void 0 ? [] : [latestUser.seq];
					const request = {
						expectedRevision: current.revision,
						people: [...current.people],
						assistantRequirements: [...current.assistantRequirements],
						memories: [...current.memories]
					};
					if (args.action === "add_person") {
						if (request.people.length >= 5) throw new Error(`people already has 5 entries`);
						if (!args.person_name?.trim()) throw new Error("person_name is required");
						Object.assign(request, { people: [...request.people, {
							id: `person-${randomUUID()}`,
							name: args.person_name,
							information: args.information ?? "",
							preference: args.preference ?? "",
							relationship: args.relationship ?? "",
							source: "user",
							evidenceSeqs: [...sourceSeqs],
							updatedAt: Date.now()
						}] });
					} else if (args.action === "update_person" || args.action === "remove_person") {
						if (!args.person_id) throw new Error("person_id is required");
						const people = [...request.people];
						const at = people.findIndex((person) => person.id === args.person_id);
						if (at < 0) throw new Error(`person not found: ${args.person_id}`);
						if (args.action === "remove_person") people.splice(at, 1);
						else {
							const previous = people[at];
							people.splice(at, 1, {
								...previous,
								name: args.person_name ?? previous.name,
								information: args.information ?? previous.information,
								preference: args.preference ?? previous.preference,
								relationship: args.relationship ?? previous.relationship,
								source: "user",
								evidenceSeqs: [.../* @__PURE__ */ new Set([...previous.evidenceSeqs, ...sourceSeqs])],
								updatedAt: Date.now()
							});
						}
						Object.assign(request, { people });
					} else if (args.action === "upsert_item" || args.action === "remove_item") {
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
					} else throw new Error(`Unsupported memory action: ${String(args.action)}`);
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
				name: PERSONA_SECTION,
				order: PERSONA_ORDER,
				text: () => renderAssistantRequirements(this.get(agent))
			});
			agent.ctx.systemPrompt.section({
				name: "session-memory:personalization",
				order: 10,
				text: () => renderSessionMemoryContext(this.get(agent))
			});
		}
	};
})();
//#endregion
export { emptySessionMemoryFoldState as _, renderSessionMemory as a, sessionMemoryView as b, EXTRACTION_SYSTEM as c, parseExtraction as d, parseOverwriteReview as f, emptySessionMemory as g, applySessionMemoryEvent as h, renderAssistantRequirements as i, MAX_MEMORY_CARDS as l, turnExtractionInput as m, DEFAULT_AUTO_EXTRACT_BELOW_UTILIZATION as n, renderSessionMemoryContext as o, reviewOverwrites as p, sessionMemoryUtilization as r, DEFAULT_PROFILE_CHARACTERS as s, SessionMemoryService as t, mergeExtraction as u, foldSessionMemory as v, migrateLegacyDocument as y };
