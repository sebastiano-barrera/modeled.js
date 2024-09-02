// Import the required Deno modules
import { parseArgs } from "https://deno.land/std/cli/parse_args.ts";
import { dirname } from "https://deno.land/std/path/mod.ts";
import { TextLineStream } from "https://deno.land/std@0.224.0/streams/text_line_stream.ts";

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
    console.log("running command", args.join(" "));
    const arg0 = args.shift();
    const cmd = new Deno.Command(arg0, { args: args });
    const { code, stdout, stderr } = await cmd.output();
    const stdoutText = new TextDecoder().decode(stdout);

    if (code !== 0) {
        const stderrText = new TextDecoder().decode(stderr);
        console.error("command failed");
        console.error("stderr:");
        for (const line of stderrText.split("\n")) {
            console.error("| ", line);
        }
        console.error("stdout:");
        for (const line of stdoutText.split("\n")) {
            console.error("| ", line);
        }

        throw new Error(`Command failed. See logged output`);
    }

    return stdoutText.trim();
}

class Process {
    constructor() {
        this.child = null;
    }

    start() {
        if (this.child !== null) {
            return;
        }
        
        // const head = await getHEAD();
        // const outputFileName = `results-${head}.txt`;

        const here = dirname(import.meta.url);
        const cmd = new Deno.Command(Deno.execPath(), {
            args: [
                "run", "--allow-read", "--allow-run",
                `${here}/run262.js`,
                "--test262", test262Path,
                "--config", configPath,
                "--fanout", "4",
            ],
            stdout: "piped",
            stderr: "piped",
        });
        this.child = cmd.spawn();

        if (this.onMessage) {
            pipeStreamToHandler(
                this.child.stdout,
                line => this.onMessage?.(JSON.parse(line)),
            );
        }

        if (this.onStderrLine) {
            pipeStreamToHandler(this.child.stderr, line => this.onStderrLine(line));
        }

        this.child.status
            .then(exitCode => { this.child = null; })
            .then(exitCode => {
                this.onFinish?.({ exitCode });
            });
    }

    get isActive() { return this.child !== null; }

    async cancel() {
        if (this.child === null) {
            return;
        }

        this.child.kill();
    }
}

class Debouncer {
    constructor(limit) { 
        this.limit = limit;
        this.pass = true;
    }
    tick() {
        if (this.pass === false) return false;
        this.pass = false;
        setTimeout(
            () => { this.pass = true; }, 
            this.limit
        );
        return true;
    }
}

class TestOutput {
    static VALID_OUTCOMES = {
        success: true,
        failure: true,
        skipped: true,
    };

    constructor() {
        this.summary = {};
        this.reset();
    }

    reset() {
        for (const outcome in TestOutput.VALID_OUTCOMES) {
            this.summary[outcome] = 0;
        }
    }

    addMessage(msg) {
        this.summary[msg.outcome]++;
    }
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
    let quit = false;
    
    function Loop(name) {
        this.name = name;
        this.skipsCount = 0;
    }

    let currentLoopIndex = 0;
    let loops = [
        new Loop("focused"),
        new Loop("full"),
    ];
    let statusMessage = '';
    let currentOutput = new TestOutput();

    const currentProcess = new Process();
    const redrawDbnc = new Debouncer(100);
    currentProcess.onMessage = function(message) {
        currentOutput.addMessage(message);
        if (redrawDbnc.tick()) {
            redraw();
        }
    };
    currentProcess.onFinish = function() { 
        redraw();
    };

    Deno.stdin.setRaw(true, {cbreak: true});
    const keybuf = new Uint8Array(1);
    async function readKey() {
        await Deno.stdin.read(keybuf);
        return String.fromCodePoint(keybuf[0]);
    }

    function redraw() {
        console.clear();
        console.log('loops    ',
            loops.map((loop, index) =>  {
                let indicator = (index === currentLoopIndex ? '*': ' ');
                return `${indicator} [${index + 1}] ${loop.name}`;
            }).join(' | ')
         );
        const statusStr = currentProcess.isActive ? 'running' : 'idle';
        console.log(`${statusStr} %c${statusMessage}`, 'color: red');
        console.log();

        for (const key in TestOutput.VALID_OUTCOMES) {
            const count = currentOutput.summary[key];
            if (count === undefined) continue;
            console.log(
                key.padEnd(10, '.') + String(count).padStart(4, '.'),
                '| ',
                '*'.repeat(count),
            );
        }
        console.log();

        for (const cmdKey in commands) {
            const cmd = commands[cmdKey];
            if (!cmd.hidden) {
                console.log(`[${cmdKey}] ${cmd.label}`);
            }
        }
    }

    const cmdSwitch = n => ({
        label: 'Switch to loop #' + (n + 1),
        hidden: true,
        action() { 
            if (n < loops.length) currentLoopIndex = n;
        }
    });
    const commands = {
        q: {
            label: 'quit',
            action() { quit = true; }
        },

        s: {
            label: 'start',
            async action() {
                if (currentProcess.isActive) {
                    statusMessage = 'currently running!';
                    return;
                }

                await ensureFilesCommitted();

                currentOutput.reset();
                statusMessage = '';
                currentProcess.start();
            },
        },

        c: {
            label: 'cancel',
            action() {
                if (!currentProcess.isActive) {
                    statusMessage = 'nothing running';
                    return;
                }

                statusMessage = '';
                currentProcess.cancel();
            },
        },
        
        "1": cmdSwitch(0),
        "2": cmdSwitch(1),
    };

    while (!quit) {
        redraw();

        let cmd;
        do { 
            const key = await readKey();
            cmd = commands[key];
        } while(cmd === undefined);
        await cmd.action();
    }

    currentProcess.cancel();
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

function pipeStreamToHandler(stream, handler) {
    stream
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TextLineStream())
        .pipeTo(new WritableStream({ write: handler }));
}

