import { audiotool } from "@audiotool/nexus";
import type { AudiotoolClient } from "@audiotool/nexus";
import type { SampleMeta, SampleFormat } from "@audiotool/nexus/api";
import {
  summarizeSample,
  formatLabel,
  listSamplesPageByPage,
  checkAvailability,
} from "./sample-api";
import { loadLibrarySampleIntoMachiniste } from "./machiniste";
import { openDatabase } from "./persistence/db";
import type { IndexStore } from "./persistence/indexStore";
import { GlobalPublishQueue } from "./global/publishQueue";
import type { GlobalSampleIndex } from "./global/contract";
import { createGlobalProvider, readProviderFor } from "./global/liveProvider";
import {
  acceptUsageAndEnqueue,
  flushPendingPublications,
  reconstructPending,
} from "./global/usageAcceptance";
import { mountAuthenticated } from "./ui/main";
import { openFirstProject } from "./ui/liveSession";

const CLIENT_ID = (import.meta.env.VITE_AUDIOTOOL_CLIENT_ID as string) || "";
const SAMPLE_SCOPE = (import.meta.env.VITE_SAMPLE_SCOPE as string) || "project:write";
// Step 16I: the live Worker base URL. The Worker URL is NOT a secret. When
// absent, publication is offline-first (pending) via the 16H fallback.
const GLOBAL_WORKER_URL =
  (import.meta.env.VITE_GLOBAL_WORKER_URL as string) || "";

type LogLevel = "info" | "ok" | "warn" | "err";

const logEl = document.getElementById("log") as HTMLElement;

function log(level: LogLevel, text: string) {
  const line = document.createElement("div");
  line.className = `log-${level}`;
  const stamp = new Date().toISOString().slice(11, 19);
  line.textContent = `[${stamp}] [${level.toUpperCase()}] ${text}`;
  logEl.appendChild(line);
  console.log(`[${level}]`, text);
}

function logSection(title: string) {
  const h = document.createElement("div");
  h.className = "log";
  h.style.fontWeight = "bold";
  h.textContent = `\n===== ${title} =====`;
  logEl.appendChild(h);
}

function makeButton(id: string, label: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.id = id;
  btn.textContent = label;
  return btn;
}

function makeSelect(id: string): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.id = id;
  return sel;
}

function makePre(id: string): HTMLPreElement {
  const pre = document.createElement("pre");
  pre.id = id;
  return pre;
}

function makeAudio(): HTMLAudioElement {
  const a = document.createElement("audio");
  a.controls = true;
  return a;
}

/**
 * Step 16H: open the local SampleMap IndexedDB for persisting usage-acceptance
 * markers. Offline-first — returns undefined instead of throwing so the POC
 * boot flow is never broken by a local-storage failure.
 */
async function safeOpenLocalIndex(): Promise<IndexStore | undefined> {
  try {
    const handle = await openDatabase();
    return handle.index;
  } catch {
    return undefined;
  }
}

/**
 * Step 16H/16I: resolve the provider for the publish queue. When a Worker URL
 * is configured, this is the LIVE `CloudflareGlobalAdapter` (app → worker →
 * D1). Otherwise it returns the 16H offline-first fallback (pending/retryable).
 */
async function resolvePublishProvider(): Promise<GlobalSampleIndex | undefined> {
  try {
    return await createGlobalProvider({ baseUrl: GLOBAL_WORKER_URL || undefined });
  } catch {
    return undefined;
  }
}

async function main() {  const sdk = { _status: "unauthenticated" as string };

  // Step 16H/16I: bootstrap the publish queue + persist local acceptance
  // markers. Uses the LIVE provider when `VITE_GLOBAL_WORKER_URL` is set,
  // else offline-first. Never throws into the signature flow.
  let publishQueue: GlobalPublishQueue | undefined;
  const publishIndex = await safeOpenLocalIndex();
  const publishProvider = await resolvePublishProvider();
  if (publishIndex && publishProvider) {
    publishQueue = new GlobalPublishQueue(publishProvider, {});
    try {
      const enqueued = await reconstructPending({ index: publishIndex, queue: publishQueue });
      if (GLOBAL_WORKER_URL) {
        log("info", `Global publish: live provider @ ${GLOBAL_WORKER_URL}; ${enqueued} previously-accepted sample(s) re-queued.`);
      } else {
        log("info", `Global publish: OFFLINE provider (no VITE_GLOBAL_WORKER_URL); ${enqueued} previously-accepted sample(s) re-queued pending delivery.`);
      }
    } catch {
      /* non-fatal */
    }
  } else {
    log("warn", "Global publish: local index or provider unavailable — acceptance markers will not persist.");
  }

  if (!CLIENT_ID) {
    log("err", "VITE_AUDIOTOOL_CLIENT_ID is not set. Create a client at https://developer.audiotool.com/applications and restart the dev server.");
  } else {
    log("info", `Booting POC with clientId=${CLIENT_ID} scope=${SAMPLE_SCOPE}`);
    const at = await audiotool({
      clientId: CLIENT_ID,
      redirectUrl: window.location.origin + "/",
      scope: SAMPLE_SCOPE,
    });

    if (at.status === "unauthenticated") {
      sdk._status = "unauthenticated";
      logSection("Authentication");
      log("info", "Not authenticated.");
      if (at.error) log("warn", `Auth error: ${at.error.message}`);
      const loginBtn = document.getElementById("login") as HTMLButtonElement;
      loginBtn.style.display = "block";
      loginBtn.textContent = "Log in with Audiotool";
      loginBtn.onclick = () => at.login();
      return;
    }

    sdk._status = "authenticated";
    logSection("Authentication");
    log("ok", `OK — authenticated as "${at.userName}"`);

    // Step 16N: minimal live browser glue. After OAuth succeeds, open the user's
    // first usable project and mount the REAL SampleMap UI over that session so
    // a real browser run can exercise: real Sample Pool -> analyze -> map ->
    // select -> inspector -> Send to Machiniste. Non-fatal: a project-open or
    // mount failure never breaks the existing POC auth/error behaviour.
    const appRoot = document.getElementById("app");
    if (appRoot) {
      mountLiveSampleMap(at, appRoot, publishQueue, publishProvider).catch((e) => {
        log("err", `SampleMap mount failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      });
    }

    await runSamplePoc(at, publishQueue, publishIndex);
  }
}

/**
 * Step 16N — open the user's first usable project and mount the existing
 * SampleMap UI (no new services; reuses `openFirstProject` + `mountAuthenticated`).
 *
 * STEP58 — the already-designed but previously unwired D1 browser READ path is
 * activated here: the single provider that already backs the publish queue is
 * reused as `globalIndex` when a live Worker URL is configured, so
 * `mountAuthenticated` triggers `refreshGlobalPoints()` → `queryMapViewport()`
 * and the global pool renders on the map. Absent the URL the read stays
 * unwired (offline map behavior unchanged).
 */
async function mountLiveSampleMap(
  at: AudiotoolClient,
  root: HTMLElement,
  publishQueue?: GlobalPublishQueue,
  publishProvider?: GlobalSampleIndex,
) {
  const doc = await openFirstProject(at);
  if (!doc) {
    throw new Error("no usable project to open for SampleMap");
  }
  log("info", `SampleMap: opened project doc, mounting UI`);
  await mountAuthenticated(root, {
    client: at,
    doc,
    authenticatedUserName: (at as { userName?: string }).userName,
    globalPublishQueue: publishQueue,
    globalPublishDelivery: GLOBAL_WORKER_URL ? "live" : "offline",
    // STEP58 — reuse the SAME provider as `globalIndex` (publish + read share
    // one instance when a live Worker URL is configured; otherwise unset).
    globalIndex: readProviderFor(publishProvider, Boolean(GLOBAL_WORKER_URL)),
  });
}

async function runSamplePoc(
  at: AudiotoolClient,
  publishQueue?: GlobalPublishQueue,
  publishIndex?: IndexStore,
) {
  // Status of the samples API
  logSection("Sample API");
  if (!at.samples) {
    log("warn", "client.samples is NOT available on this build");
    return;
  }
  log("ok", "client.samples: AVAILABLE");

  // ---------- LIST ----------
  logSection("List samples");
  let sampleList: SampleMeta[] = [];
  let listError: Error | null = null;
  try {
    const { samples, pageCount, stopped } = await listSamplesPageByPage(at.samples, {
      pageSize: 20,
      maxSamples: 20,
    });
    sampleList = samples;
    log("ok", `list(): SUCCESS (${pageCount} page(s), stoppedEarly=${stopped})`);
    log("info", `Samples returned: ${samples.length}`);
  } catch (e) {
    listError = e instanceof Error ? e : new Error(String(e));
    log("err", `list(): FAILED — ${listError.message}`);
    log("warn", `Cause: ${String((listError as any).cause ?? "")}`);
  }

  if (listError || sampleList.length === 0) {
    log("warn", "Cannot continue without a sample list.");
    return;
  }

  // Show the sample summary table
  const table = document.createElement("pre");
  table.className = "log";
  table.textContent = sampleList
    .map((s, i) => `${String(i + 1).padEnd(3)} ${s.name}  ${s.displayName}  [${s.kind}]  ${s.visibility}  ${s.ownerName}`)
    .join("\n");
  logEl.appendChild(table);

  // Cross-user evidence: count distinct owners in the listed page.
  const distinctOwners = new Set(sampleList.map((s) => s.ownerName));
  log("info", `Distinct owners in page: ${distinctOwners.size}`);
  if (distinctOwners.size > 1) {
    log("ok", `Multiple owners present — listing returns samples from different users (not only self).`);
  } else {
    log("info", `Only ${distinctOwners.size} distinct owner(s) in this page.`);
  }

  // ---------- SELECT + GET ----------
  logSection("Select & fetch single sample");
  const ctrlRow = document.createElement("div");
  ctrlRow.className = "row";
  const select = makeSelect("sample-select");
  for (let i = 0; i < sampleList.length; i++) {
    const s = sampleList[i];
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `${s.displayName} (${s.name})`;
    select.appendChild(opt);
  }
  const loadBtn = makeButton("load-sample", "Load Sample");
  ctrlRow.appendChild(select);
  ctrlRow.appendChild(loadBtn);
  logEl.appendChild(ctrlRow);

  const metaPre = makePre("sample-meta");
  logEl.appendChild(metaPre);

  const dowloadRow = document.createElement("div");
  dowloadRow.className = "row";
  const formats: SampleFormat[] = ["wav", "flac", "mp3", "preview"];
  const dlButtons: Record<string, HTMLButtonElement> = {};
  for (const f of formats) {
    const b = makeButton(`dl-${f}`, `Download ${formatLabel(f)}`);
    b.disabled = true;
    dlButtons[f] = b;
    dowloadRow.appendChild(b);
  }
  logEl.appendChild(dowloadRow);

  const dlPre = makePre("download-log");
  logEl.appendChild(dlPre);

  const playLabel = document.createElement("div");
  playLabel.className = "row";
  playLabel.textContent = "Playback:";
  logEl.appendChild(playLabel);
  const audio = makeAudio();
  audio.id = "playback";
  logEl.appendChild(audio);

  let current: SampleMeta | null = null;

  async function loadSample() {
    const idx = Number(select.value);
    const ref = sampleList[idx];
    logSection(`Get metadata: ${ref.name}`);

    try {
      const meta = await at.samples.get(ref);
      if (meta instanceof Error) {
        log("err", `get(): FAILED — ${meta.message}`);
        return;
      }
      current = meta;
      log("ok", `get(): SUCCESS`);
      metaPre.textContent = summarizeSample(meta);

      const av = checkAvailability(meta);
      log("info", `WAV=${av?.wav} FLAC=${av?.flac} MP3=${av?.mp3} Preview=${av?.preview}`);

      for (const f of formats) {
        dlButtons[f].disabled = av ? !av[f] : true;
      }
      machBtn.disabled = false;
      machPre.textContent = "";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log("err", `get(): FAILED — ${msg}`);
    }
  }

  loadBtn.onclick = loadSample;

  async function download(format: SampleFormat) {
    if (!current) return;
    dlPre.textContent = "";
    const label = formatLabel(format);
    logSection(`Download ${format} for ${current.name}`);
    try {
      const blob = await at.samples.download(current, { format });
      if (blob instanceof Error) {
        log("err", `${label} download: FAILED — ${blob.message}`);
        return;
      }
      log("ok", `${label} download: SUCCESS`);
      log("info", `Bytes: ${blob.size}  Type: ${blob.type || "unknown"}`);

      const url = URL.createObjectURL(blob);
      log("ok", `Audio Blob: SUCCESS (ObjectURL created, length=${blob.size})`);
      audio.src = url;
      audio.load();
      log("ok", "Audio playback element: LOADED");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log("err", `${label} download: FAILED — ${msg}`);
    }
  }

  dlButtons.wav.onclick = () => download("wav");
  dlButtons.flac.onclick = () => download("flac");
  dlButtons.mp3.onclick = () => download("mp3");
  dlButtons.preview.onclick = () => download("preview");

  // Minimal Machiniste integration test (opt-in; mutates a real project).
  const machRow = document.createElement("div");
  machRow.className = "row";
  const machBtn = makeButton("machiniste-test", "Machiniste Direct-Reference Test");
  machBtn.disabled = true;
  machRow.appendChild(machBtn);
  logEl.appendChild(machRow);
  const machPre = makePre("machiniste-log");
  logEl.appendChild(machPre);

  async function runMachinisteTest() {
    if (!current) {
      log("warn", "No sample selected. Load a sample first (use the dropdown).");
      return;
    }
    machBtn.disabled = true;
    machPre.textContent = "";
    logSection("Machiniste direct-reference test");

    // A) Open a real project (first from the user's list).
    let project = undefined as { name: string; displayName: string } | undefined;
    try {
      const projects = await at.projects.listProjects({ pageSize: 5 });
      if (projects instanceof Error) {
        throw projects;
      }
      const first = projects.projects[0];
      if (!first) {
        throw new Error("no projects returned");
      }
      project = first;
      log("ok", `Project: ${first.name} ("${first.displayName}")`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log("err", `listProjects(): FAILED — ${msg}`);
      machBtn.disabled = false;
      return;
    }

    // B) Open + sync the document.
    let doc;
    try {
      doc = await at.open(project!.name);
      await doc.start();
      log("ok", `SyncedDocument started (${doc.dawUrl})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log("err", `open()/start(): FAILED — ${msg}`);
      machBtn.disabled = false;
      return;
    }

    // C) Load the current (cross-user public) sample by DIRECT reference.
    try {
      const result = await loadLibrarySampleIntoMachiniste(doc, current);
      machPre.textContent = JSON.stringify(
        {
          sample: {
            name: current.name,
            ownerName: current.ownerName,
            visibility: current.visibility,
            displayName: current.displayName,
          },
          machinisteId: result.machinisteId,
          sampleEntityId: result.sampleEntityId,
          channelSampleEntityId: result.channelSampleEntityId,
          directReferenceApplied: result.directReferenceApplied,
          readBackMatches: result.readBackMatches,
          created: result.created,
          errors: result.errors,
        },
        null,
        2,
      );
      if (result.readBackMatches && result.errors.length === 0) {
        log("ok", `DIRECT REFERENCE APPLIED + READ BACK VERIFIED into Machiniste ${result.machinisteId}`);

        // Step 16H: verified usage acceptance → persist marker + enqueue global
        // publication. Never breaks the diagnostics path (offline-first).
        if (publishQueue && publishIndex) {
          try {
            const outcome = await acceptUsageAndEnqueue(
              { index: publishIndex, queue: publishQueue },
              { kind: "poc", result },
            );
            if (outcome.accepted) {
              log("ok", `Usage ACCEPTED for ${current.name}; publish enqueued (${outcome.enqueued}).`);
              const delivered = await flushPendingPublications({
                index: publishIndex,
                queue: publishQueue,
              });
              log(
                "info",
                `Publish delivery: submitted=${delivered.flush.submitted}, succeeded=${delivered.flush.succeeded}, markedLocalPublished=${delivered.markedPublished}`,
              );
            } else {
              log("warn", `Usage NOT accepted for global publish: ${outcome.reason}`);
            }
          } catch {
            log("err", "Global publish orchestration failed (non-fatal).");
          }
        }
      } else {
        log("err", `Machiniste test did not fully verify: readBackMatches=${result.readBackMatches}, errors=${JSON.stringify(result.errors)}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log("err", `loadLibrarySampleIntoMachiniste() threw — ${msg}`);
    } finally {
      try {
        await doc!.stop();
      } catch {
        /* ignore */
      }
      machBtn.disabled = false;
    }
  }

  machBtn.onclick = runMachinisteTest;

  // Minimal auto real-access test surface (runs after login).
  // Picks a public sample that is plausibly from another user (owner differs
  // from the first sample's owner, when more than one owner is present), then
  // exercises get() + download() across all formats the sample supports.
  async function autoRunRealTest() {
    logSection("Real access auto-test");
    if (sampleList.length === 0) {
      log("warn", "No samples to test.");
      return;
    }
    const firstOwner = sampleList[0].ownerName;
    const candidate =
      sampleList.find((s) => s.visibility === "public" && s.ownerName !== firstOwner) ??
      sampleList[0];
    select.value = String(sampleList.indexOf(candidate));
    await loadSample();
    if (!current) return;
    log("info", `Testing sample: ${current.name} (owner=${current.ownerName}, visibility=${current.visibility})`);
    const av = checkAvailability(current);
    const formatsToTry: SampleFormat[] = ["wav"];
    if (av?.flac) formatsToTry.push("flac");
    if (av?.mp3) formatsToTry.push("mp3");
    if (av?.preview) formatsToTry.push("preview");
    for (const f of formatsToTry) {
      await download(f);
    }
  }

  await autoRunRealTest();
}

main().catch((e) => {
  log("err", `Fatal error: ${e instanceof Error ? e.message : String(e)}`);
});
