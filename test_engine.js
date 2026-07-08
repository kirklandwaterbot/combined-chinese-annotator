const fs = require('fs');
globalThis.OpenCC = require('./opencc.js'); // Assuming opencc is available or I can mock it
// Actually I can just load it
const engineCode = fs.readFileSync('pinyin-web-engine.js', 'utf8');

// We need to run it in a context
const vm = require('vm');
const context = {
  console: console,
  setTimeout: setTimeout,
  // mock CombinedConverter
  globalThis: {
    CombinedConverter: {
      toSimplified: (text) => text // just identity for now to see if it crashes
    }
  }
};
vm.createContext(context);
vm.runInContext(`
  var nChars = {};
  var Annotator = {};
  ${engineCode}
  globalThis.Annotator = Annotator;
`, context);

const data = fs.readFileSync('annotate-dat.txt', 'utf8');
context.globalThis.Annotator.data = data;

try {
  let result = context.globalThis.Annotator.annotate("「PRC」重定向至此。关于广义上的中国", 0);
  console.log("Success:", result.slice(0, 100));
} catch (e) {
  console.error("Error:", e);
}
