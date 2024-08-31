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

/**
 * Runs a shell command and executes an event handler for each line of output.
 * @param {string[]} args - The command and its arguments as an array.
 * @param {(line: string) => void} lineHandler - Called for each line of output.
 * @returns {Promise<number>} The exit code of the command.
 */
async function watchCommand(args, handlers) {
    const arg0 = args.shift();
    const cmd = new Deno.Command(arg0, {
        args: args,
        stdout: "piped",
        stderr: "piped",
    });

    const child = cmd.spawn();

    function pipeStreamToHandler(stream, handler) {
        stream
            .pipeThrough(new TextDecoderStream())
            .pipeThrough(new TextLineStream())
            .pipeTo(new WritableStream({
                write(chunk) {
                    handlers.onStdoutLine(chunk);
                },
            }));
    }

    if (handlers?.onStdoutLine) {
        pipeStreamToHandler(child.stdout, handlers.onStdoutLine);
    }
    if (handlers?.onStderrLine) {
        pipeStreamToHandler(child.stderr, handlers.onStderrLine);
    }

    const { code } = await child.status;
    return code;
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
    return await fakeGoCommand();
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
        "--fanout", "4",
    ];

    const head = await getHEAD();
    const outputFileName = `results-${head}.txt`;

    const exitCode = await watchCommand(testCommand, {
        onStdoutLine(line) {
            console.log('stdout | ', line);
        },

        onStderrLine(line) {
            console.log('stderr | ', line);
        },
    });

    console.log('exit code', exitCode);
    
    // await Deno.writeTextFile(outputFileName, output);
    // console.log(`Test output written to ${outputFileName}`);
}

async function fakeGoCommand() {
    let quit = false;
    
    function Loop(name) {
        this.name = name;
        this.skipsCount = 0;
    }

    const model = {
        currentLoopIndex: 0,
        loops: [
            new Loop("focused"),
            new Loop("full"),
        ],

        currentProcess: null,

        statusMessage: '',
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
            model.loops
            .map((loop, index) =>  {
                let indicator = (index === model.currentLoopIndex ? '*': ' ');
                return `${indicator} [${index + 1}] ${loop.name}`;
            }).join(' | ')
         );
        console.log();

        console.log('status', (model.currentProcess ? 'running' : 'idle'));
        console.log('%c' + model.statusMessage, 'color: red');
        console.log();

        if (model.summary) {
            for (const key in model.summary) {
                const count = model.summary[key];
                console.log(
                    key.padEnd(10, '.') + String(count).padStart(4, '.'),
                    '| ',
                    '*'.repeat(count),
                );
            }
        }
        console.log();

        for (const cmdKey in commands) {
            const cmd = commands[cmdKey];
            if (!cmd.hidden) {
                console.log(`[${cmdKey}] ${cmd.label}`);
            }
        }
    }

    class Process{
        constructor() {
            this.count = 200;
            this.intervalID = null;
        }

        start() {
            if (this.intervalID !== null) return;

            this.intervalID = setInterval(() => {
                this.count--;
                if (this.count <= 0) {
                    this.cancel();
                    return;
                }

                if (this.onMessage === undefined) return;
                const dice = Math.random();
                let msg;
                if (dice < 0.3) { msg = { outcome: 'failure' }; }
                else if (dice < 0.6) { msg = { outcome: 'skipped' }; }
                else { msg = { outcome: 'success' }; }

                this.onMessage(msg);
            }, 100);
        }

        cancel() {
            if (this.intervalID === null) return;
            clearInterval(this.intervalID);
            this.onFinish?.();
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

    const cmdSwitch = n => ({
        label: 'Switch to loop #' + (n + 1),
        hidden: true,
        action() { 
            if (n < model.loops.length) model.currentLoopIndex = n;
        }
    });
    const commands = {
        n: {
            label: 'Next',
            action() {
                model.countdown--;
            },
        },
        q: {
            label: 'Quit',
            action() { quit = true; }
        },

        s: {
            label: 'start',
            action() {
                if (model.currentProcess !== null) {
                    model.statusMessage = 'currently running!';
                    return;
                }

                const redrawDbnc = new Debouncer(500);

                model.summary = null;
                model.currentProcess = new Process();
                model.currentProcess.onMessage = function(message) {
                    model.summary ??= {};
                    model.summary[message.outcome] ??= 0;
                    model.summary[message.outcome]++;
                    if (redrawDbnc.tick()) {
                        redraw();
                    }
                };
                model.currentProcess.onFinish = function() {
                    model.currentProcess = null;
                    redraw();
                };
                model.currentProcess.start();
            },
        },

        c: {
            label: 'cancel',
            action() {
                if (model.currentProcess === null) {
                    model.statusMessage = 'nothing running';
                    return;
                }

                model.currentProcess.cancel();
                model.currentProcess = null;
            },
        },
        
        "1": cmdSwitch(0),
        "2": cmdSwitch(1),
    };

    while (!quit) {
        redraw();

        let cmd;
        do{ 
            const key = await readKey();
            cmd = commands[key];
        } while(cmd === undefined);
        cmd.action();
    }

    model.currentProcess?.cancel();
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
