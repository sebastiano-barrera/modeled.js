import * as acorn from 'npm:acorn';

// overview of the plan:
//
//  - impl 1: as a naive ast interpreter, validated against test262
//      - vm state includes stack and heap
//      - stack identifies variable by names
//  - impl 2: bytecode interpreter, with coarse instructions

class AssertionError extends Error {}
function assert(value, msg) {
    if (!value) {
        throw new AssertionError('assertion failed: ' + msg);
    }
} 


class VMError extends Error {}

class ProgramException extends Error {
    constructor(exceptionValue, context) {
        super('interpreted js program exception');
        this.exceptionValue = exceptionValue;

        this.context = context.map(node => {
            const {loc: {start, end}, type} = node
            const text 
                = node.end - node.start <= 100 
                ? node.sourceFile.getRange(node.start, node.end) 
                : '...';
            return `${type} - ${start.line}:${start.column}-${end.line}:${end.column} - ${text}`
        });
    }
}

class VMObject {
    #proto = null
    type = 'object'

    constructor(proto = PROTO_OBJECT) {
        this.properties = new Map()
        this.proto = proto
    }

    getProperty(name) { return this.properties.get(name) || { type: 'undefined' } }
    setProperty(name, value) { 
        return this.properties.set(name, value)
    }
    deleteProperty(name) { return this.properties.delete(name) }

    get proto() { return this.#proto }
    set proto(newProto) {
        assert (newProto === null || newProto instanceof VMObject, "VMObject's prototype must be VMObject or null");
        this.#proto = newProto;
    }
}

const PROTO_OBJECT = new VMObject(null)
const PROTO_FUNCTION = new VMObject()

class VMInvokable extends VMObject {
    type = 'function'

    constructor() {
        super();
        this.proto = PROTO_FUNCTION;
        this.setProperty('prototype', new VMObject())
    }

    invoke() { throw new AssertionError('invoke not implemented'); }
}

class VMFunction extends VMInvokable {
    constructor(params, body) {
        super();
        this.params = params;
        this.body = body;
        this.parentScope = null;
    }

    invoke(vm, subject, args) {
        for (const ndx in this.params) {
            const name = this.params[ndx];
            const value = args[ndx] || { type: 'undefined' };
            vm.defineVar(name, value);
        }

        try { vm.runStmt(this.body) }
        catch (e) {
            if (e.returnValue) {
                assert (typeof e.returnValue.type === 'string', "return value uninitialized!");
                return e.returnValue;
            }
            throw e;
        }

        return {type: "undefined"}
    }
}

class VarScope {
    constructor() {
        this.vars = new Map()
        this.parent = null
    }

    defineVar(name, value) {
        assert(typeof name === 'string', 'var name must be string');
        this.vars.set(name, value);
    }

    setVar(name, value) {
        if (this.vars.has(name)) this.vars.set(name, value);
        else if (this.parent) this.parent.setVar(name, value);
        else {
            const exc = new VMObject();
            exc.setProperty('name', 'NameError');
            exc.setProperty('message', 'unbound variable: ' + name)
            throw new ProgramException(exc, [...this.synCtx]);
        }
    }

    lookupVar(name) {
        const value = this.vars.get(name);
        if (typeof value !== 'undefined') return value;
        if (this.parent) return this.parent.lookupVar(name);
        throw new VMError('unbound variable: ' + name);
    }

    deleteVar(name) {
        // TODO involve parent scopes
        return this.vars.delete(name);
    }
}

class EnvScope {
    constructor(env) {
        assert (env instanceof VMObject, "environment must be an object");
        this.env = env;
        this.dontDelete = new Set();
    }

    defineVar(name, value) { this.env.setProperty(name, value); }
    setVar(name, value) { this.defineVar(name, value); }

    lookupVar(name) {
        // TODO! only the innermost scope is used
        const value = this.env.getProperty(name);
        if (value) return value;
        throw new VMError('unbound variable: ' + name);
    }

    deleteVar(name) {
        if (this.dontDelete.has(name)) return false;
        return this.env.deleteProperty(name);
    }

    setDoNotDelete(name) { this.dontDelete.add(name) }
}


export class VM {
    constructor() {
        this.globalObj = createGlobalObject()
        this.currentScope = null
        this.synCtx = []
        this.synCtxError = []
    }

    //
    // VM state (variables, stack, heap, ...)
    //

    defineVar(name, value) { return this.currentScope.defineVar(name, value); }
    setVar(name, value)    { return this.currentScope.setVar(name, value); }
    deleteVar(name)        { return this.currentScope.deleteVar(name); }
    lookupVar(name, value) { return this.currentScope.lookupVar(name, value); }
    setDoNotDelete(name)   { return this.currentScope.setDoNotDelete(name); }
    #withScope(inner) {
        const scope = new VarScope()
        scope.parent = this.currentScope;
        this.currentScope = scope;

        try { return inner(); }
        finally {
            assert(this.currentScope === scope, 'stack manipulated!');
            this.currentScope = scope.parent; 
        }
    }

    #unsupportedNode(node) {
        throw new VMError('unsupported node: ' + Deno.inspect(node));
    }

    #withSyntaxContext(node, inner) {
        this.synCtxError = [];
        try {
            this.synCtx.push(node);
            return inner();
        } catch(err) {
            this.synCtxError.push(`${node.type} ${node.loc.start.line}-${node.loc.end.line}`)
            if (node.end - node.start <= 100) {
                const excerpt = node.sourceFile.getRange(node.start, node.end);
                for (const line of excerpt.split('\n')) {
                    this.synCtxError.push('  > ' + line)
                }
            }

            throw err;
        } finally {
            const check = this.synCtx.pop();
            assert (check === node, 'bug! syntax context manipulated');
        }
    }

    //
    // Statements
    //

    runScript(script) {
      const {path, text} = script;
      const ast = acorn.parse(text, {
          ecmaVersion: 2020,
          directSourceFile: new SourceWrapper(text),
          locations: true,
      });

      return this.runProgram(ast);
    }

    runProgram(node) {
        assert(node.sourceType === "script", 'only script is supported');
        assert(node.type === "Program", 'must be called with a Program node');

        return this.#withSyntaxContext(node, () => {
            try {
                assert (this.currentScope === null, 'nested program!');

                const topScope = new EnvScope(this.globalObj);
                this.currentScope = topScope;
                this.currentScope.this = this.globalObj;

                this.runBlockBody(node.body);

                assert (this.currentScope === topScope, "stack manipulated!");
                this.currentScope = null;
                return { outcome: 'success' }

            } catch (err) {
                if (err instanceof ProgramException) {
                    return {
                        outcome: 'error',
                        error: err,
                    }
                }

                if (this.synCtxError) {
                    console.error('with syntax context:');
                    for (const line of this.synCtxError) {
                        console.error('|  ' + line);
                    }
                    this.synCtxError = [];
                }

                throw err;
            }
        });
    }

    runBlockBody(body) {
        for (const stmt of body) {
            this.runStmt(stmt);
        }
    }

    runStmt(stmt) { return this.#dispatch(stmt, this.stmts) }

    performCall(callee, subject, args) {
        assert (callee instanceof VMInvokable, 'you can only call a function (native or virtual), not ' + Deno.inspect(callee));
        assert (subject.type, 'subject should be a VM value');

        return this.#withScope(() => {
            this.currentScope.this = subject;
            return callee.invoke(this, subject, args);
        })
    }

    #dispatch(node, table) {
        return this.#withSyntaxContext(node, () => {
            const handler = table[node.type]
            if (handler) return handler.call(this, node);
            return this.#unsupportedNode(node);
        });
    }

    stmts = {
        BlockStatement(stmt) {
            this.runBlockBody(stmt.body);
        },

        TryStatement(stmt) {
            try {
                this.#withScope(() => this.runStmt(stmt.block));
            } catch(err) {
                if (err instanceof ProgramException && stmt.handler) {
                    assert(stmt.handler.type === 'CatchClause', "parser bug: try statement's handler must be CatchClause");
                    assert(stmt.handler.param.type === 'Identifier', 'only supported: catch clause param Identifier');
                    
                    const paramName = stmt.handler.param.name;
                    const body = stmt.handler.body;
                    this.#withScope(() => {
                        this.defineVar(paramName, err.exceptionValue);
                        this.setDoNotDelete(paramName);
                        this.runStmt(body);
                    });

                } else {
                    // either pass the ProgramException to another of the program's try blocks
                    // or pass the VMError to the VM caller
                    throw err;
                }
            } finally {
                if (stmt.finalizer) 
                    this.#withScope(() => this.runStmt(stmt.finalizer));
            }
        },
        ThrowStatement(stmt) {
            const exceptionValue = this.evalExpr(stmt.argument);
            throw new ProgramException(exceptionValue, [...this.synCtx]);
        },

        FunctionDeclaration(stmt) {
            if (stmt.id.type === 'Identifier') {
                const name = stmt.id.name;
                assert(!stmt.expression, "unsupported func decl type: expression");
                assert(!stmt.generator,  "unsupported func decl type: generator");
                assert(!stmt.async,      "unsupported func decl type: async");

                this.defineVar(name, this.makeFunction(stmt.params, stmt.body));
                
            } else {
                throw new VMError('unsupported identifier for function declaration: ' + Deno.inspect(stmt.id));
            }
        },

        ExpressionStatement(stmt) {
            // discard return value
            this.evalExpr(stmt.expression);
        },

        IfStatement(stmt) {
            const test = this.evalExpr(stmt.test);

            if (this.isTruthy(test)) {
                this.runStmt(stmt.consequent);
            } else if (stmt.alternate) {
                this.runStmt(stmt.alternate);
            }
        },
        
        VariableDeclaration(node) {
            if (node.kind !== "var" && node.kind !== "let" && node.kind !== "const")
                throw new VMError('unsupported var decl type: ' + node.kind);

            for (const decl of node.declarations) {
                assert (decl.type === 'VariableDeclarator', "decl type must be VariableDeclarator");
                if (decl.id.type === "Identifier") {
                    const name = decl.id.name;
                    const value = decl.init ? this.evalExpr(decl.init) : { type: 'undefined' };
                    this.defineVar(name, value);

                } else {
                    throw new VMError("unsupported declarator id type: " + decl.id.type)
                }
            }
        },

        ReturnStatement(node) {
            if (node.argument === null)
                throw {returnValue: {type: 'undefined'}};

            const returnValue = this.evalExpr(node.argument);
            throw { returnValue };
        }
    }

    //
    // Expressions
    //
    evalExpr(node) { 
        const value = this.#dispatch(node, this.exprs);
        assert (
            typeof value === 'object' && typeof value.type === 'string',
            `expr handler for ${node.type} did not return a value: ${Deno.inspect(value)}`
        );
        return value;
    }

    makeFunction(paramNodes, body) {
        const params = paramNodes.map(paramNode => {
            assert(paramNode.type === 'Identifier', 'unsupported: func params of type ' + paramNode.type);
            return paramNode.name;
        });

        const func = new VMFunction(params, body);
        func.parentScope = this.currentScope;
        return func;
    }

    isTruthy({ type, value }) {
        if (type === 'object') {
            throw new VMError('not yet implemented: isTruthy for object');
        }

        assert (typeof value === type, `bug: ${type} value does not have ${type} value, but ${typeof value}!`);

        if (type === 'boolean') { return value; }
        else if (type === 'string') { return value.length > 0; }

        throw new VMError('not yet implemented: isTruthy: ' + Deno.inspect(value));
    }

    exprs = {
        AssignmentExpression(expr) {
            let value = this.evalExpr(expr.right);
            
            if (expr.operator === '=') { }
            else if (expr.operator === '+=') {
                const updateExpr = {...expr, type: 'BinaryExpression', operator: '+'};
                value = this.evalExpr(updateExpr);
            } else {
                throw new VMError('unsupported update assignment op. ' + Deno.inspect(expr));
            }

            assert(!expr.left.computed, 'unsupported: MemberExpression.computed');
            assert(!expr.left.optional, 'unsupported: MemberExpression.optional');

            if (expr.left.type === "MemberExpression") {
                const obj = this.evalExpr(expr.left.object);
                assert(expr.left.property.type === 'Identifier', 'unsupported member property: ' + expr.left.property.type);
                const propertyName = expr.left.property.name;

                obj.setProperty(propertyName, value);

            } else if (expr.left.type === "Identifier") {
                const name = expr.left.name;
                this.setVar(name, value);
                
            } else {
                throw new VMError('unsupported assignment target: ' + Deno.inspect(stmt.id));
            }

            return value;
        },

        FunctionExpression(expr) {
            assert(expr.id === null, "unsupported: function expression with non-null id: " + expr.id);
            assert(!expr.expression, "unsupported: FunctionExpression.expression");
            assert(!expr.generator,  "unsupported: FunctionExpression.generator");
            assert(!expr.async,      "unsupported: FunctionExpression.async");

            return this.makeFunction(expr.params, expr.body);
        },

        ObjectExpression(expr) {
            assert(expr.properties.length === 0, "unsupported: non-empty object literals");
            return new VMObject()
        },

        MemberExpression(expr) {
            assert(!expr.optional, "unsupported: MemberExpression.optional");

            const object = this.evalExpr(expr.object);
            if (expr.computed) {
                const key = this.evalExpr(expr.property);
                if (key.type === 'string')
                    return object.getProperty(key.value);
                throw new AssertionError('MemberExpression: unsupported key type: ' + key.tpe);
            }

            assert (expr.property.type === 'Identifier', 'MemberExpression: !computed, but property not an Identifier');
            return object.getProperty(expr.property.name);
        },

        UnaryExpression(expr) {
            if (expr.operator === 'delete') {
                assert (expr.prefix, 'parser bug: delete must be prefix');
                assert (expr.argument.type === 'Identifier', 'only supported: delete <Identifier>');

                const name = expr.argument.name;
                const didDelete = this.deleteVar(name);
                return {type: 'boolean', value: didDelete};
                
            } else {
                throw new VMError('unsupported unary op: ' + expr.operator);
            }
        },

        BinaryExpression(expr) {
            if      (expr.operator === '===') { return this.tripleEqual(expr.left, expr.right); }
            else if (expr.operator === '!==') {
                const ret = this.tripleEqual(expr.left, expr.right);
                ret.value = !ret.value;
                return ret;
            }
            else if (expr.operator === '+') {
                const left = this.evalExpr(expr.left);
                const right = this.evalExpr(expr.right);
                
                const a = this.valueToPrimitive(left);
                const b = this.valueToPrimitive(right);

                if (a.type === 'number' && b.type === 'number') {
                    return {type: 'number', value: a.value + b.value};
                } else {
                    const as = this.valueToString(a);
                    const bs = this.valueToString(b);
                    assert (as.type === 'string', 'valueToString bug (a)');
                    assert (bs.type === 'string', 'valueToString bug (b)');
                    return {type: 'string', value: as.value + bs.value};
                }
            }
            else { throw new VMError('unsupported binary op: ' + expr.operator); }
        },

        LogicalExpression(expr) {
            if (expr.operator === '||') {
                const left = this.evalExpr(expr.left);
                if (this.isTruthy(left)) { return left; }
                return this.evalExpr(expr.right);

            } else  if (expr.operator === '&&') {
                const left = this.evalExpr(expr.left);
                if (!this.isTruthy(left)) { return left; }
                return this.evalExpr(expr.right);

            } else {
                throw new VMError('unsupported logical op: ' + expr.operator);
            }
        },

        NewExpression(expr) {
            const obj = new VMObject();

            const callee = this.evalExpr(expr.callee);
            const args = expr.arguments.map(argNode => this.evalExpr(argNode));
            const retVal = this.performCall(callee, obj, args);
            assert (typeof retVal === 'object', 'vm bug: invalid return type from call');

            obj.setProperty('constructor', callee);
            obj.proto = callee.getProperty('prototype');

            return retVal.type === 'undefined' ? obj : retVal;
        },

        CallExpression(expr) {
            const args = expr.arguments.map(argNode => this.evalExpr(argNode));
            let callThis;
            let callee;

            if (expr.callee.type === 'MemberExpression' 
                && expr.callee.property.type === "Identifier"
            ) {
                assert (!expr.callee.computed, "only supported: member call with !computed");
                assert (!expr.callee.optional, "only supported: member call with !optional");

                const name = expr.callee.property.name;

                callThis = this.evalExpr(expr.callee.object);
                callee = callThis.getProperty(name);
                if (callee.type === 'undefined') {
                    throw new VMError(`can't find method ${name} in ${Deno.inspect(callThis)}`);
                }

            } else {
                callThis = { type: "undefined" };
                callee = this.evalExpr(expr.callee);
                if (callee.type === 'undefined' || callee.type === 'null') {
                    throw new VMError(`can't invoke undefined/null: ${Deno.inspect(expr.callee)}`);
                }
            }

            return this.performCall(callee, callThis, args);
        },

        ThisExpression(expr) { 
            for (let scope=this.currentScope; scope; scope = scope.parent) {
                if (scope.this) return scope.this;
            }
            return {type: 'undefined'};
        },

        Identifier(node) {
            return this.lookupVar(node.name);
        },

        Literal(node) {
            const value = node.value;
            const type = typeof value;

            if (type === 'number' || type === 'string') {
                return {type, value};

            } else {
                throw new VMError(`unsupported literal value: ${typeof node.value} ${Deno.inspect(node.value)}`);
            }
        }
    }

    tripleEqual(left, right) {
        left = this.evalExpr(left);
        right = this.evalExpr(right);

        const value = (left.type === right.type && left.value === right.value);
        return { type: 'boolean', value };
    }

    valueToPrimitive(value) {
        if (value instanceof VMObject) {
            for (const methodName of ['valueOf', 'toString']) {
                const method = value.getProperty(methodName);
                if (method.type !== 'function') continue;

                const ret = this.performCall(method, value, []);
                if (ret.type !== 'object') return ret;
                
            }

            return { type: 'undefined' };
            
        } else {
            assert (typeof value.type === 'string', 'invalid value');
            return value;
        }
    }

    valueToString(value) {
        if (value instanceof VMObject) {
            throw new VMError('bug: value must be primitive')
        }

        assert (value.type === typeof value.value, 'invalid value');

        return {
            type: 'string', 
            value: '' + value.value
        };
    }
}


function createGlobalObject() {
    const G = new VMObject();

    G.setProperty('String', new class extends VMInvokable {
        invoke(vm, subject, args) { 
            if(subject.type === 'undefined') {
                // invoked as function, not via new
                return vm.valueToString(args[0])
            } else {
                // invoked via new
                throw new VMError('not yet implemented: new String(...)')
            }
        }
    })

    G.setProperty('nativeHello', new class extends VMInvokable {
        invoke(vm, subject, args) {
            console.log('hello world!')
            return {type: 'undefined'}
        }
    })

    G.setProperty('$print', new class extends VMInvokable {
        invoke(vm, subject, args) {
            for (const arg of args) {
                const prim = vm.valueToPrimitive(arg)
                console.log(prim)
            }
            return {type: 'undefined'}
        }
    })

    return G;
}

class SourceWrapper {
    #text;
    constructor(text) { this.#text = text }
    getRange(start, end) { return this.#text.slice(start, end) }
}


