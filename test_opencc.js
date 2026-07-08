const fs = require('fs');
const vm = require('vm');

const context = {
  console: console,
  setTimeout: setTimeout,
  globalThis: {}
};
vm.createContext(context);

const openccCode = fs.readFileSync('opencc.js', 'utf8');
vm.runInContext(openccCode + '\n globalThis.OpenCC = OpenCC;', context);

const converterCode = fs.readFileSync('converter.js', 'utf8');
vm.runInContext(converterCode, context);

const result = context.globalThis.CombinedConverter.toSimplified('測試');
console.log("Type of result:", typeof result);
console.log("Result:", result);
