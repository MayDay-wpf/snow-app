import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runRemoteGit } from "../../ssh/remoteGit";
import type { GitCheckoutResult } from "../../../preload/types/git";

const execFileAsync = promisify(execFile);
const pending = new Set<string>();

/** One narrow command runner for local and SSH branch management, never a shell locally. */
export async function manageGitBranch(
  repoPath: string,
  action: "create" | "rename" | "delete",
  branch: string,
  name?: string,
  remote = false,
  force = false,
): Promise<GitCheckoutResult> {
  if (pending.has(repoPath))
    return { success: false, message: "Branch operation already in progress" };
  pending.add(repoPath);
  const run = async (args: string[]): Promise<string> => {
    if (repoPath.startsWith("ssh://")) return runRemoteGit(repoPath, args);
    const result = await execFileAsync(
      "git",
      ["-c", "core.quotepath=false", "-C", repoPath, ...args],
      { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
    );
    return result.stdout;
  };
  const validate = async (value: string): Promise<void> => {
    if (!value || value.startsWith("-") || value === "HEAD")
      throw new Error("Invalid branch name");
    await run(["check-ref-format", `refs/heads/${value}`]);
  };
  try {
    await validate(branch);
    if (action === "create") {
      if (!name) throw new Error("New branch name is required");
      await validate(name);
      // Fully qualified source refs disambiguate local names from remote-tracking names.
      const source = `${remote ? "refs/remotes/" : "refs/heads/"}${branch}`;
      await run(["show-ref", "--verify", source]);
      await run([
        "branch",
        remote ? "--track" : "--no-track",
        "--",
        name,
        source,
      ]);
    } else {
      if (remote)
        throw new Error("Remote branch deletion/rename is not supported");
      await run(["show-ref", "--verify", `refs/heads/${branch}`]);
      // Fail closed if worktree enumeration fails; include unmanaged and prunable trees.
      const trees = await run(["worktree", "list", "--porcelain"]);
      if (
        trees
          .split(/\r?\n/)
          .some((line) => line === `branch refs/heads/${branch}`)
      ) {
        throw new Error("Cannot modify a branch checked out in any worktree");
      }
      const head = (
        await run(["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")
      ).trim();
      if (head === `refs/heads/${branch}`)
        throw new Error("Cannot modify the current branch");
      if (action === "rename") {
        if (!name) throw new Error("New branch name is required");
        await validate(name);
        await run(["branch", "-m", "--", branch, name]);
      } else {
        // Safe delete first; `-D` is only reached after the UI confirms the
        // unmerged-commit loss, so refs cannot be discarded by a single click.
        await run(["branch", force ? "-D" : "-d", "--", branch]);
      }
    }
    return { success: true, message: "" };
  } catch (cause) {
    return {
      success: false,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    pending.delete(repoPath);
  }
}
