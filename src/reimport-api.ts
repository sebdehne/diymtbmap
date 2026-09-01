import express from "express";
import { errorLog, log } from "./log.js";
import type { ReimportStatus, ReimportTriggerResult } from "./reimport.js";

export interface ReimportApi {
  martinReady: () => boolean;
  trigger: () => Promise<ReimportTriggerResult>;
  state: () => ReimportStatus;
}

export function createReimportRouter(api: ReimportApi): express.Router {
  const router = express.Router();

  router.get("/api/reimport", (_req, res) => {
    res.json(api.state());
  });

  router.post("/api/reimport", async (_req, res) => {
    log("reimport: POST /api/reimport received");
    if (!api.martinReady()) {
      log("reimport: rejected — Martin tile server is not ready (503)");
      res.status(503).json({ error: "tile-server-not-ready" });
      return;
    }

    let result: ReimportTriggerResult;
    try {
      result = await api.trigger();
    } catch (e) {
      const message = `reimport trigger failed: ${e instanceof Error ? e.message : String(e)}`;
      errorLog(`reimport: ${message}`);
      res.status(500).json({ error: message });
      return;
    }

    if (result.decision.kind === "started") {
      log(`reimport: accepted — started (latest dataset ${result.decision.latestDate})`);
      res.status(202).json({ started: true, latestDate: result.decision.latestDate });
      return;
    }
    if (result.decision.kind === "upstream-error") {
      errorLog("reimport: rejected — cannot determine the latest dataset (502)");
      res.status(502).json({ error: "cannot-determine-latest" });
      return;
    }
    log(`reimport: rejected — ${result.decision.error} (409)`);
    res.status(409).json({ error: result.decision.error });
  });

  return router;
}
