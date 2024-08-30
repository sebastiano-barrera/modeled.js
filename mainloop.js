// Import the required Deno modules
import { parseArgs } from "https://deno.land/std/cli/parse_args.ts";
import { dirname } from "https://deno.land/std/path/mod.ts";

async function getBranchLength() {
    // Get the number of commits ahead of master
    return await runCommand([
        "git",
        "rev-list",
        "--count",
        `master..${branchName}`,
    ]);
}

async function getCurrentBranchName() {
    return await runCommand([
        "git",
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
    ]);
}

/** @param args {string[]} */
async function runCommand(args) {
    console.log("running command", args);
    const arg0 = args.shift();
    const cmd = new Deno.Command(arg0, { args: args });
    const { code, stdout, stderr } = await cmd.output();

    if (code !== 0) {
        const stderrText = new TextDecoder().decode(stderr);
        throw new Error(`Command failed: ${stderrText}`);
    }

    const stdoutText = new TextDecoder().decode(stdout);
    return stdoutText.trim();
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
    console.log(
        "Usage: deno run script.js [go|squash] --test262 <path> --config <path>",
    );
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
        console.log(
            "Usage: deno run script.js [go|squash] --test262 <path> --config <path>",
        );
        break;
}

async function goCommand() {
    await ensureFilesCommitted();

    const here = dirname(import.meta.url);

    const testCommand = [
        "deno",
        "run",
        "--allow-read",
        "--allow-run",
        `${here}/run262.js`,
        "--test262",
        test262Path,
        "--config",
        configPath,
    ];

    const head = await getHEAD();
    const outputFileName = `results-${head}.txt`;

    const output = await runCommand(testCommand);
    await Deno.writeTextFile(outputFileName, output);
    console.log(`Test output written to ${outputFileName}`);
}

async function getHEAD() {
    return await runCommand([
        "git",
        "rev-parse",
        "HEAD",
    ]);
}

async function ensureFilesCommitted() {
    const status = await runCommand(["git", "status", "--porcelain"]);
    if (status.trim() === "") {
        console.log("No uncommitted changes detected.");
        return;
    }

    const commitMessage = `checkpoint #${branchLength}`;
    console.log("Uncommitted changes detected. Creating a new commit...");
    await runCommand(["git", "add", "-u"]);
    await runCommand(["git", "commit", "-m", commitMessage]);
    console.log("Changes committed successfully.");
}

// Define the "squash" subcommand
async function squashCommand() {
    throw new Error("not yet implemented");
}
