import fs from "node:fs";
import path from "node:path";
import { main } from "./main.js";

function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* walk(full);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".wav")) {
            yield full;
        }
    }
}

const files = [...walk("docs/wav")].sort();

const results = { passed: [], failed: [] };
for (const file of files) {
    console.log(`\n=== ${file} ===`);
    try {
        await main(file);
        results.passed.push(file);
    } catch (err) {
        console.error(`FAILED: ${file}: ${err.message}`);
        results.failed.push({ file, error: err.message });
    }
}

console.log(`\n=== summary ===`);
console.log(`passed: ${results.passed.length}/${files.length}`);
console.log(`failed: ${results.failed.length}/${files.length}`);
for (const { file, error } of results.failed) {
    console.log(`  ${file}: ${error}`);
}
