import { chromium } from "playwright";
import { writeFileSync } from "fs";

const PROFILE = "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step68-real-profile";
const OUT = "/var/folders/q8/d49rh__50139j_9q8wqx0g9r0000gn/T/opencode/step68";

async function main() {
  const pw = await chromium.launchPersistentContext(PROFILE, {
    headless: true, channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  const page = await pw.newPage();
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(4000);

  const probe = await page.evaluate(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("samplemap", 3); r.onerror = () => rej(r.error);
      r.onsuccess = () => res(r.result);
    });
    const readStore = (name) => new Promise((res, rej) => {
      const tx = db.transaction(name, "readonly");
      const req = tx.objectStore(name).getAll();
      req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
    });
    const countStore = (name) => new Promise((res, rej) => {
      const tx = db.transaction(name, "readonly");
      const req = tx.objectStore(name).count();
      req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
    });

    const jobs = await readStore("jobs");
    const samples = await readStore("samples");
    const samplesCount = await countStore("samples");

    const jobStatuses = {};
    const jobSampleIds = new Set();
    const jobBuilds = new Set();
    const jobDetails = [];
    for (const j of jobs) {
      jobStatuses[j.status] = (jobStatuses[j.status] || 0) + 1;
      if (j.sampleId) jobSampleIds.add(j.sampleId);
      if (j.analysisBuild) jobBuilds.add(j.analysisBuild);
      jobDetails.push({
        sampleId: j.sampleId, status: j.status, build: j.analysisBuild,
        createdAt: j.createdAt, updatedAt: j.updatedAt, attempts: j.attempts,
        priorityGroup: j.priorityGroup,
      });
    }

    const sampleStatuses = {};
    let analyzed = 0, withAudio = 0, withMapPos = 0, withSC = 0, withHier = 0;
    let loops = 0, oneShots = 0, invalid = 0;
    const owners = new Set();
    const kinds = {};
    const hierVersions = {};
    const builds = {};
    const sampleDetails = [];
    for (const s of samples) {
      sampleStatuses[s.status] = (sampleStatuses[s.status] || 0) + 1;
      if (s.status === "analyzed") analyzed++;
      if (s.audioFeatures) withAudio++;
      if (s.mapPosition) withMapPos++;
      if (s.analysisV2 && s.analysisV2.soundCharacter) withSC++;
      if (s.hier) { withHier++; hierVersions[s.hier] = (hierVersions[s.hier] || 0) + 1; }
      if (!s.sampleId || !s.status) invalid++;
      if (s.owner) owners.add(s.owner);
      kinds[s.kind] = (kinds[s.kind] || 0) + 1;
      if (s.kind === "loop") loops++;
      else if (s.kind === "one-shot") oneShots++;
      builds[s.analysisBuild] = (builds[s.analysisBuild] || 0) + 1;
      sampleDetails.push({
        sampleId: s.sampleId, name: s.name, owner: s.owner, status: s.status,
        kind: s.kind, tags: s.originalTags || [],
        hasAudioFeatures: !!s.audioFeatures, hasMapPosition: !!s.mapPosition,
        hasSoundCharacter: !!(s.analysisV2 && s.analysisV2.soundCharacter),
        contentHashVersion: s.contentHashVersion || "", hier: s.hier || "",
        analysisBuild: s.analysisBuild || "",
        createdAt: s.createdAt || "", analyzedAt: s.analyzedAt || "",
      });
    }

    db.close();
    return {
      sampleCount: samplesCount, totalSamples: samples.length, sampleStatuses,
      analyzed, withAudio, withMapPos, withSC, withHier, invalid,
      loops, oneShots, uniqueOwners: owners.size, kinds, hierVersions, builds,
      totalJobs: jobs.length, jobStatuses, jobUniqueSampleIds: jobSampleIds.size,
      jobBuilds: [...jobBuilds],
      sampleDetails, jobDetails,
    };
  })()`);

  writeFileSync(`${OUT}/step68-idb-probe.json`, JSON.stringify(probe, null, 2));
  console.log(JSON.stringify(probe, null, 2));
  await pw.close();
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
