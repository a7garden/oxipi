import { join } from "path";

// =============================================================================
// WorktreeInfo
// =============================================================================

export interface WorktreeInfo {
	path: string;
	branch: string;
	head: string;
}

// =============================================================================
// WorktreeManager — git worktree lifecycle
// =============================================================================

export class WorktreeManager {
	private repoPath: string;

	constructor(repoPath: string) {
		this.repoPath = repoPath;
	}

	/** Create a new worktree with a dedicated branch */
	async create(branchName: string, baseBranch: string = "main"): Promise<WorktreeInfo> {
		const { execSync } = await import("child_process");
		const worktreesDir = join(this.repoPath, ".worktrees");
		const worktreePath = join(worktreesDir, branchName);

		// Ensure .worktrees directory exists
		execSync(`mkdir -p "${worktreesDir}"`, { cwd: this.repoPath });

		try {
			execSync(`git worktree add -b "${branchName}" "${worktreePath}" "${baseBranch}"`, {
				cwd: this.repoPath,
				stdio: "pipe",
			});
		} catch (e: any) {
			// Worktree might already exist — try to find it
			const output = execSync(`git worktree list --porcelain`, { cwd: this.repoPath, encoding: "utf-8" });
			const lines = output.split("\n");
			let current: WorktreeInfo | null = null;
			for (const line of lines) {
				if (line.startsWith("worktree ")) current = { path: line.slice(8).trim(), branch: "", head: "" };
				else if (line.startsWith("branch refs/heads/") && current) current.branch = line.slice(17).trim();
				else if (line.startsWith("HEAD ") && current) current.head = line.slice(5).trim();
				else if (line === "" && current && current.path === worktreePath) return current;
			}
			throw e;
		}

		return { path: worktreePath, branch: branchName, head: "" };
	}

	/** Remove a worktree */
	async remove(worktreePath: string, force: boolean = false): Promise<void> {
		const { execSync } = await import("child_process");
		execSync(`git worktree remove "${worktreePath}"${force ? " --force" : ""}`, {
			cwd: this.repoPath,
			stdio: "pipe",
		});
	}

	/** List all worktrees */
	async list(): Promise<WorktreeInfo[]> {
		const { execSync } = await import("child_process");
		const output = execSync(`git worktree list --porcelain`, { cwd: this.repoPath, encoding: "utf-8" });
		const worktrees: WorktreeInfo[] = [];
		const lines = output.split("\n");
		let current: WorktreeInfo | null = null;
		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				if (current) worktrees.push(current);
				current = { path: line.slice(8).trim(), branch: "", head: "" };
			} else if (line.startsWith("branch refs/heads/") && current) {
				current.branch = line.slice(17).trim();
			} else if (line.startsWith("HEAD ") && current) {
				current.head = line.slice(5).trim();
			} else if (line === "" && current) {
				worktrees.push(current);
				current = null;
			}
		}
		if (current) worktrees.push(current);
		return worktrees;
	}
}
