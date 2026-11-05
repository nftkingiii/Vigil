/** Print the /feedback received, newest first, without chat ids: npm run feedback (run where DATA_DIR is). */
import { feedback } from "../src/store.ts";

for (const f of feedback.texts()) console.log(`${f.createdAt}  ${f.text}`);
console.log(`\n${feedback.count()} in all`);
