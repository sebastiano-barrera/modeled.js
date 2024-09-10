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
	M.bindingPattern(
		M._CV!,
		patternAST,
		value,
		(name, value) => bset.set(name, value),
	);
	return bset;
}

type BindingSet = Map<string, M.JSValue>;

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
	expect(bset.get("lol")).toBe(num);
});

Deno.test("object: single property renamed", () => {
	using _ = useNewVM();
	const num: M.JSValue = { type: "number", value: 123.0 };
	const value = new M.VMObject();
	value.setProperty("lol", num);
	const bset = bindingPatternJS("var {lol: asd} = _", value);
	expect(bset.get("asd")).toBe(num);
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
	expect(moreKeys[0]).toBe("c");
	expect(moreKeys[1]).toBe("d");
	expect(moreKeys[2]).toBe("e");
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
	expect(bset.get("t")).toMatchObject({ type: "undefined" });
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

Deno.test("pattern: array of objects", () => {
	using _ = useNewVM();

	const objectsArray = new M.VMArray();
	for (let i = 0; i < 5; i++) {
		const obj = new M.VMObject();
		obj.setProperty("theNumber", { type: "number", value: Math.random() });
		objectsArray.arrayElements.push(obj);
	}

	const bset = bindingPatternJS("var [{ theNumber }, ...rest] = _", objectsArray);

	expect(bset.size).toBe(2);
	const elm0 = <M.VMObject>objectsArray.arrayElements[0];
	expect(elm0).toBeInstanceOf(M.VMObject);
	expect(bset.get("theNumber")).toBe(elm0.getProperty("theNumber"));

	const rest = <M.VMArray>bset.get("rest");
	expect(rest).toBeInstanceOf(M.VMArray);
	expect(rest.arrayElements).toHaveLength(4);
});

Deno.test("pattern: object of array", () => {
	using _ = useNewVM();

	const isSelected: M.JSValue = {type: 'boolean', value: false};
	const x: M.JSValue = {type: 'number', value: 99.012};

	const object = new M.VMObject();
	object.setProperty("isSelected", isSelected);
	object.setProperty("x", x);

	const numbers = new M.VMArray();
	for (let i=0; i < 5; i++) {
		numbers.arrayElements.push({ type: 'number', value: Math.random() * 1000.0 });
	}
	object.setProperty("numbers", numbers);

	const bset = bindingPatternJS("var {isSelected, numbers: [a, b, ...more]} = _", object);

	expect(bset.size).toBe(4);
	expect(bset.get("isSelected")).toBe(isSelected);
	expect(bset.get("a")).toBe(numbers.arrayElements[0]);
	expect(bset.get("b")).toBe(numbers.arrayElements[1]);
});

