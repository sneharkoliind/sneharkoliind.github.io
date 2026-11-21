// Pull the latest resume version from the local ResumeCraft app into the site.
//   npm run sync-resume        (the resume app backend must be running on :8000)
// Writes src/data/resume.json (phone removed) and public/resume.pdf (public PDF without phone).
import { writeFile } from "node:fs/promises";

const API = process.env.RESUME_API || "http://127.0.0.1:8000/api/resumes";
const id = process.env.RESUME_ID || "1";

const versions = await (await fetch(`${API}/${id}/versions`)).json();
if (!versions.length) throw new Error("No saved resume versions yet. Save a version in the app first.");
const latest = versions[0];
const data = structuredClone(latest.data);
data.basics.phone = "";                       // never publish the phone number

await writeFile(new URL("../src/data/resume.json", import.meta.url),
  JSON.stringify({ version: latest.version, label: latest.label, synced: new Date().toISOString(), ...data }, null, 2));

const pdf = await fetch(`${API}/${id}/pdf?version=${latest.version}&public=true&save=false`);
if (!pdf.ok) throw new Error(`PDF failed: ${pdf.status}`);
await writeFile(new URL("../public/resume.pdf", import.meta.url), Buffer.from(await pdf.arrayBuffer()));

console.log(`Synced resume v${latest.version} (${latest.label}) → src/data/resume.json, public/resume.pdf (${pdf.headers.get("x-pages")} page)`);
