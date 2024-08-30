// Import the required Deno modules
import { parseArgs } from "https://deno.land/std/cli/parse_args.ts";

async function getBranchLength() {
    // Get the number of commits ahead of master
    return await runGitCommand([
        "rev-list",
        "--count",
        `master..${branchName}`,
    ]);
}

async function getCurrentBranchName() {
    return await runGitCommand([
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
    ]);
}

async function runGitCommand(args) {
    console.log('running git command', args);
    const { code, stdout, stderr } = await new Deno.Command("git", { args })
        .output();
    if (code !== 0) {
        throw new Error(
            `Git command failed: ${new TextDecoder().decode(stderr)}`,
        );
    }
    return new TextDecoder().decode(stdout).trim();
}

const branchName = await getCurrentBranchName();
const branchLength = await getBranchLength();

console.log("Current branch: ", branchName);
const args = parseArgs(Deno.args, {
  string: ["test262", "config"],
  default: { test262: "", config: "" },
});

const test262Path = args.test262;
const configPath = args.config;

if (!test262Path || !configPath) {
  console.log("Usage: deno run script.js [go|squash] --test262 <path> --config <path>");
  Deno.exit(1);
}

switch (args._[0]) {
    case "go":
    await goCommand(test262Path, configPath);
        break;
    case "squash":
        await squashCommand();
        break;
    default:
    console.log("Usage: deno run script.js [go|squash] --test262 <path> --config <path>");
        break;
}

async function goCommand() {
    await ensureFilesCommitted();

    const testCommand = [
        "deno",
        "run",
        "--allow-read",
        "run262.js",
    ];

    const head = await getHEAD();
    const outputFileName = `results-${head}.txt`;

    console.log('test command', testCommand)

    const command = new Deno.Command(testCommand[0], {
        args: testCommand.slice(1),
    });

    try {
        const { stdout } = await command.output();
        await Deno.writeTextFile(
            outputFileName,
            new TextDecoder().decode(stdout),
        );
        console.log(`Test output written to ${outputFileName}`);
    } catch (error) {
        console.error(`Test command failed: ${error.message}`);
        if (error.stderr) {
            console.error(new TextDecoder().decode(error.stderr));
        }
    }
}

async function getHEAD() {
    return await runGitCommand([
        "rev-parse",
        "HEAD",
    ]);
}

async function ensureFilesCommitted() {
    const status = await runGitCommand(["status", "--porcelain"]);
    if (status.trim() === "") {
        console.log("No uncommitted changes detected.");
        return;
    }

    const commitMessage = `checkpoint #${branchLength}`;
    console.log("Uncommitted changes detected. Creating a new commit...");
    await runGitCommand(["add", "-u"]);
    await runGitCommand(["commit", "-m", commitMessage]);
    console.log("Changes committed successfully.");
}

// Define the "squash" subcommand
async function squashCommand() {
    throw new Error("not yet implemented");
}
