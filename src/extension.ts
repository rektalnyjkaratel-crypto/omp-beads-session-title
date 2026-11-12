import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export interface BeadsIssue {
	id: string;
	parents: string[];
}

type JsonRecord = Record<string, unknown>;
type TrackedSession = {
	ids: string[];
	issues: Map<string, BeadsIssue>;
	scheduled: boolean;
};

const BEADS_ID = /(?<![a-z0-9])([a-z][a-z0-9]*(?:[._-][a-z0-9]+)+)(?![a-z0-9])/gi;
const BEADS_MARKER = /\s*⟦bd:([^;⟧]+)(?:;\s*parent:([^⟧]+))?⟧/g;
const TITLE_POLL_MS = 250;
const TITLE_WAIT_MS = 30_000;
const BEADS_COMMAND = /(?:^|(?:&&|\|\||[;|])\s*)bd(?:\s|$)/;

function asRecord(value: unknown): JsonRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function unique(ids: readonly string[]): string[] {
	const seen = new Set<string>();
	return ids.filter(id => {
		const key = id.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function extractBeadIdCandidates(prompt: string): string[] {
	return unique([...prompt.matchAll(BEADS_ID)].map(match => match[1]!));
}

export function isBeadsCommand(command: string): boolean {
	return BEADS_COMMAND.test(command);
}

function dependencyParent(dependency: JsonRecord): string | undefined {
	const relationship = asString(dependency.type) ?? asString(dependency.dependency_type);
	if (relationship !== "parent-child") return undefined;
	return asString(dependency.depends_on_id) ?? asString(dependency.id);
}

export function parseBeadsIssue(output: string, expectedId?: string): BeadsIssue | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return undefined;
	}

	const values = Array.isArray(parsed) ? parsed : [parsed];
	const issue = values.map(asRecord).find(value => {
		const id = asString(value?.id);
		return id !== undefined && (expectedId === undefined || id.toLowerCase() === expectedId.toLowerCase());
	});
	const id = asString(issue?.id);
	if (!issue || !id) return undefined;

	const dependencies = Array.isArray(issue.dependencies) ? issue.dependencies : [];
	const parents = unique(dependencies.map(asRecord).flatMap(dependency => (dependency ? [dependencyParent(dependency)] : [])).filter(Boolean) as string[]);
	const directParent = asString(issue.parent_id) ?? asString(issue.parent);
	return { id, parents: unique(directParent ? [...parents, directParent] : parents) };
}

export function findCommonParent(issues: readonly BeadsIssue[]): string | undefined {
	if (issues.length === 0) return undefined;
	const [first, ...rest] = issues;
	const parents = first!.parents.filter(parent => rest.every(issue => issue.parents.some(candidate => candidate === parent)));
	return parents.length === 1 ? parents[0] : undefined;
}

function markedIds(title: string | undefined): string[] {
	if (!title) return [];
	return unique([...title.matchAll(BEADS_MARKER)].flatMap(match => match[1]!.split(",").map(id => id.trim()).filter(Boolean)));
}

export function appendBeadsMarker(title: string, ids: readonly string[], parent: string | undefined): string {
	const base = title.replace(BEADS_MARKER, "").trim();
	const marker = `⟦bd:${ids.join(",")}${parent ? `; parent:${parent}` : ""}⟧`;
	return base ? `${base} ${marker}` : marker;
}

async function resolveIssues(pi: ExtensionAPI, cwd: string, candidates: readonly string[]): Promise<BeadsIssue[]> {
	const issues: BeadsIssue[] = [];
	for (const candidate of candidates) {
		const result = await pi.exec("bd", ["show", "--json", candidate], { cwd, timeout: 1_500 });
		const issue = result.code === 0 ? parseBeadsIssue(result.stdout, candidate) : undefined;
		if (issue) issues.push(issue);
	}
	return issues;
}

async function resolveCurrentIssue(pi: ExtensionAPI, cwd: string): Promise<BeadsIssue | undefined> {
	const result = await pi.exec("bd", ["show", "--current", "--json"], { cwd, timeout: 1_500 });
	return result.code === 0 ? parseBeadsIssue(result.stdout) : undefined;
}

function trackIssues(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	sessions: Map<string, TrackedSession>,
	issues: readonly BeadsIssue[],
): void {
	if (issues.length === 0) return;
	const sessionId = ctx.sessionManager.getSessionId();
	const titleIds = markedIds(ctx.sessionManager.getSessionName());
	const tracked = sessions.get(sessionId) ?? { ids: titleIds, issues: new Map(), scheduled: false };
	tracked.ids = unique([...tracked.ids, ...titleIds]);
	for (const issue of issues) {
		tracked.issues.set(issue.id.toLowerCase(), issue);
		tracked.ids = unique([...tracked.ids, issue.id]);
	}
	sessions.set(sessionId, tracked);
	scheduleTitleMarker(pi, ctx, sessionId, tracked);
}

function trackedIssues(tracked: TrackedSession): BeadsIssue[] | undefined {
	const issues = tracked.ids.map(id => tracked.issues.get(id.toLowerCase()));
	return issues.every((issue): issue is BeadsIssue => issue !== undefined) ? issues : undefined;
}

function scheduleTitleMarker(pi: ExtensionAPI, ctx: ExtensionContext, sessionId: string, tracked: TrackedSession): void {
	if (tracked.scheduled) return;
	tracked.scheduled = true;
	const deadline = Date.now() + TITLE_WAIT_MS;

	const apply = () => {
		if (ctx.sessionManager.getSessionId() !== sessionId) return;
		const title = ctx.sessionManager.getSessionName();
		if (!title) {
			if (Date.now() < deadline) ctx.setTimeout(apply, TITLE_POLL_MS);
			else tracked.scheduled = false;
			return;
		}

		tracked.scheduled = false;
		const issues = trackedIssues(tracked);
		const parent = issues ? findCommonParent(issues) : undefined;
		const next = appendBeadsMarker(title, tracked.ids, parent);
		if (next !== title) {
			void pi.setSessionName(next).catch(error => {
				pi.logger.warn("beads-session-title: unable to update session title", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}
	};

	ctx.setTimeout(apply, 0);
}

export default function beadsSessionTitle(pi: ExtensionAPI): void {
	const sessions = new Map<string, TrackedSession>();

	pi.on("before_agent_start", async (event, ctx) => {
		const candidates = unique([
			...markedIds(ctx.sessionManager.getSessionName()),
			...extractBeadIdCandidates(event.prompt),
		]);
		const issues = await resolveIssues(pi, ctx.cwd, candidates);
		const current = await resolveCurrentIssue(pi, ctx.cwd);
		if (current) issues.push(current);
		trackIssues(pi, ctx, sessions, issues);
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "bash" || event.isError || !isBeadsCommand(event.input.command)) return;
		ctx.setTimeout(() => {
			void resolveCurrentIssue(pi, ctx.cwd).then(issue => {
				if (issue) trackIssues(pi, ctx, sessions, [issue]);
			});
		}, 0);
	});
}
