import fullTestConfig from './fullTestConfig.json' with {type: 'json'};
import testMeta from './testMeta.json' with {type: 'json'};

const fraction = 1.0
const predicate = path => (
  path.includes('/function')
  && (testMeta.testCases[path]?.features ?? []).length === 0
  && Math.random() < fraction
);

const filteredTestCases = []
for (const tc of fullTestConfig.testCases) {
  if (predicate(tc)) {
    filteredTestCases.push(tc);
  }
}

const output = { testCases: filteredTestCases }
console.log(JSON.stringify(output))

const nSel = filteredTestCases.length
const nTotal = fullTestConfig.testCases.length
console.error(`selected ${nSel} out of ${nTotal} test cases`)


