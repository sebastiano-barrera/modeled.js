import fullTestConfig from './fullTestConfig.json' with {type: 'json'};

const prefix = 'test/language/literals/'
const prob = 0.2

const filteredTestCases = []
console.log(fullTestConfig)
for (const tc of fullTestConfig.testCases) {
  if (tc.startsWith(prefix) && Math.random() < prob) {
    filteredTestCases.push(tc)
  }
}

const output = { testCases: filteredTestCases }
Deno.writeTextFile('./testConfig.json', JSON.stringify(output))


