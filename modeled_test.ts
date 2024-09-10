import * as M from "./modeled.ts";
import * as acorn from "npm:acorn";

import { expect } from "jsr:@std/expect";

function useNewVM(): Disposable {
	if (M._CV !== undefined) {
		throw new Error("nested VM running!");
	}

	const vm = new M.VM();
	vm.currentScope = new M.VarScope();
	M.setVM(vm);

	return {
		[Symbol.dispose]() {
			vm.currentScope = null;
			M.clearVM();
		},
	};
}

function findPatternJS(patternJS: string): acorn.Pattern {
	const ast: acorn.Program = acorn.parse(patternJS, { ecmaVersion: 2020 });
	const node1 = ast.body[0];
	if (
		node1.type !== "VariableDeclaration" ||
		node1.declarations.length !== 1
	) throw new Error("invalid test js: not in the form: [var x = _]");
	return node1.declarations[0].id;
}

function bindingPatternJS(patternJS: string, value: M.JSValue): BindingSet {
	const patternAST = findPatternJS(patternJS);
	const bset = new Map<string, M.JSValue>();
	bindingPattern(M._CV!, patternAST, value, (name, value) => bset.set(name, value));
	return bset;
}

type BindingSet = Map<string, M.JSValue>;

function bindingPattern(
	vm: M.VM,
	pattern: acorn.Pattern,
	value: M.JSValue,
	bind: (name: string, value: M.JSValue) => void,
) {
	if (pattern.type === "Identifier") {
		const ident = pattern.name;
		bind(ident, value);
	} else if (pattern.type === "ObjectPattern") {
		const object = vm.coerceToObject(value);
		if (object === undefined) {
			return vm.throwError(
				"TypeError",
				"object pattern can't be matched with value that can't be coerced to object",
			);
		}

		const count = pattern.properties.length;
		if (count === 0) {
			return;
		}

		const last = pattern.properties[count - 1];
		const restObj: undefined | M.VMObject = last.type === "RestElement"
			? object.shallowCopy()
			: undefined;

		for (const prop of pattern.properties) {
			if (prop.type === "Property") {
				if (prop.key.type === "Identifier") {
					const key = prop.key.name;
					const subValue = object.getProperty(key) ??
						{ type: "undefined" };
					bindingPattern(vm, prop.value, subValue, bind);
					if (restObj !== undefined) {
						restObj.deleteProperty(key);
					}
				} else {
					return vm.throwError(
						"TypeError",
						"unsupported syntax for object pattern key: " +
							prop.key.type,
					);
				}
			} else if (prop.type === "RestElement") {
				if (restObj instanceof M.VMObject) {
					bindingPattern(vm, prop.argument, restObj, bind);
				} else {
					throw new Error("there should be an object here!");
				}
			} else {
				const x: never = prop;
			}
		}
	} else if (pattern.type === "ArrayPattern") {
		const object = vm!.coerceToObject(value);

		const count = pattern.elements.length;
		if (count === 0) {
			return;
		}
		// const last = pattern.elements[count - 1];

		for (let i = 0; i < count; i++) {
			const elmPat = pattern.elements[i];
			if (elmPat === null) continue;

			if (elmPat.type === "RestElement") {
				if (i !== count - 1) {
					throw new Error("pattern item ...rest must be last");
				}

				const restArray = new M.VMArray();
				let elm;
				for (; (elm = object.getIndex(i)) !== undefined; i++) {
					restArray.arrayElements.push(elm);
				}
				return bindingPattern(vm, elmPat.argument, restArray, bind);
			}

			const elm = object.getIndex(i) ?? { type: 'undefined' };
			bindingPattern(vm, elmPat, elm, bind);
		}

		// TODO
	} else if (pattern.type === "AssignmentPattern") {
		if (value.type === "undefined") {
			const fallbackValue = vm!.evalExpr(pattern.right);
			bindingPattern(vm, pattern.left, fallbackValue, bind);
		} else {
			bindingPattern(vm, pattern.left, value, bind);
		}
	} else {
		throw new Error("unsupported/invalid pattern type: " + pattern.type);
	}
}

Deno.test("simple identifier", () => {
	using _ = useNewVM();
	const value: M.JSValue = { type: "number", value: 123.0 };
	const bset = bindingPatternJS("var x", value);
	expect(bset.size).toBe(1);
	expect(bset.get("x")).toBe(value);
});

Deno.test("empty object <- object", () => {
	using _ = useNewVM();
	const value = new M.VMObject();
	bindingPatternJS("var {} = _;", value);
});

Deno.test("empty object <- non object", () => {
	expect(() => {
		using _ = useNewVM();
		const value: M.JSValue = { type: "null" };
		bindingPatternJS("var {} = _", value);
	}).toThrow(M.ProgramException);
});

Deno.test("object: single property", () => {
	using _ = useNewVM();
	const num: M.JSValue = { type: "number", value: 123.0 };
	const value = new M.VMObject();
	value.setProperty("lol", num);
	const bset = bindingPatternJS("var {lol} = _", value);
	expect(bset.get('lol')).toBe(num);
});

Deno.test("object: single property, absent", () => {
	using _ = useNewVM();
	const value = new M.VMObject();
	const bset = bindingPatternJS("var {lol} = _", value);
	expect(bset.get("lol")).toMatchObject({ type: "undefined" });
});

Deno.test("object: single property, default", () => {
	using _ = useNewVM();
	const value = new M.VMObject();
	const bset = bindingPatternJS("var {lol = 99} = _", value);
	expect(bset.get("lol")).toMatchObject({ type: "number", value: 99.0 });
});

Deno.test("pattern: object, single property", () => {
	const ast = findPatternJS("var {lol} = _");
	expect(ast.type).toBe("ObjectPattern");
});

Deno.test("pattern: object, coerce", () => {
	using _ = useNewVM();

	const value: M.JSValue = { type: "number", value: 123.0 };
	const bset = bindingPatternJS("var {valueOf, toString} = _", value);

	expect(bset.size).toBe(2);
	expect(bset.get("valueOf")?.type).toBe("function");
	expect(bset.get("toString")?.type).toBe("function");
});

Deno.test("pattern: object, mix", () => {
	using _ = useNewVM();

	const num: M.JSValue = { type: "number", value: 123.0 };
	const value = new M.VMObject();
	value.setProperty("lol", num);
	value.setProperty("rofl", { type: "string", value: "something something" });

	const bset = bindingPatternJS("var {asd = 99, lol} = _", value);

	expect(bset.size).toBe(2);
	expect(bset.get("asd")).toMatchObject({ type: "number", value: 99.0 });
	expect(bset.get("lol")).toMatchObject({ type: "number", value: 123.0 });
});

Deno.test("pattern: object, ...rest", () => {
	using _ = useNewVM();

	const value = new M.VMObject();
	value.setProperty("a", { type: "number", value: 1.0 });
	value.setProperty("b", { type: "number", value: 2.0 });
	value.setProperty("c", { type: "number", value: 3.0 });
	value.setProperty("d", { type: "number", value: 4.0 });
	value.setProperty("e", { type: "number", value: 5.0 });

	const bset = bindingPatternJS("var {a, b, ...more} = _", value);

	expect(bset.size).toBe(3);
	expect(bset.get("a")).toMatchObject({ type: "number", value: 1.0 });
	expect(bset.get("b")).toMatchObject({ type: "number", value: 2.0 });

	const more = <M.VMObject> bset.get("more");
	expect(more).toBeInstanceOf(M.VMObject);

	const moreKeys = [...more.getOwnPropertyNames()];
	moreKeys.sort();
	expect(moreKeys[0]).toBe('c');
	expect(moreKeys[1]).toBe('d');
	expect(moreKeys[2]).toBe('e');
});

Deno.test("pattern: array empty", () => {
	using _ = useNewVM();

	const value = new M.VMArray();
	const bset = bindingPatternJS("var [] = _", value);
	expect(bset).toMatchObject({});
});

Deno.test("pattern: array single element", () => {
	using _ = useNewVM();

	const num: M.JSValue = { type: "number", value: 8234135.1 };
	const value = new M.VMArray();
	value.setIndex(0, num);
	const bset = bindingPatternJS("var [x] = _", value);

	expect(bset.size).toBe(1);
	expect(bset.get("x")).toBe(num);
});

Deno.test("pattern: array multiple elements", () => {
	using _ = useNewVM();

	const num0: M.JSValue = { type: "number", value: 8234135.1 };
	const num1: M.JSValue = { type: "number", value: 235.1 };
	const num2: M.JSValue = { type: "number", value: 82115.1234 };
	const value = new M.VMArray();
	value.setIndex(0, num0);
	value.setIndex(1, num1);
	value.setIndex(2, num2);
	const bset = bindingPatternJS("var [x, y, z, t] = _", value);

	expect(bset.size).toBe(4);
	expect(bset.get("x")).toBe(num0);
	expect(bset.get("y")).toBe(num1);
	expect(bset.get("z")).toBe(num2);
	expect(bset.get("t")).toMatchObject({type: 'undefined'});
});

Deno.test("pattern: array with rest pattern", () => {
	using _ = useNewVM();

	const num0: M.JSValue = { type: "number", value: 8234135.1 };
	const num1: M.JSValue = { type: "number", value: 235.1 };
	const num2: M.JSValue = { type: "number", value: 82115.1234 };
	const value = new M.VMArray();
	value.setIndex(0, num0);
	value.setIndex(1, num1);
	value.setIndex(2, num2);
	const bset = bindingPatternJS("var [x, ...rest] = _", value);

	expect(bset.size).toBe(2);
	expect(bset.get("x")).toBe(num0);

	const rest = <M.VMArray> bset.get("rest");
	expect(rest).toBeInstanceOf(M.VMArray);
	expect(rest.arrayElements).toHaveLength(2);
	expect(rest.arrayElements[0]).toBe(num1);
	expect(rest.arrayElements[1]).toBe(num2);
});
