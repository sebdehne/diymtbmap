import { useEffect, useState } from "react";
import MapView from "./MapView.jsx";
import ProgressCard from "./components/ProgressCard.jsx";

// Entry component: polls api/status once per second. While the pipeline runs
// (checking → downloading → building → starting) the progress card is shown;
// on `ready` the map mounts, on `error` the card keeps the failure details.
export default function App() {
  const [status, setStatus] = useState(null);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      let s;
      try {
        const res = await fetch("api/status", { cache: "no-store" });
        s = await res.json();
      } catch {
        if (!stopped) setFetchError(true);
        return;
      }
      if (stopped) return;
      setFetchError(false);
      setStatus(s);
      if (s.state === "ready" || s.state === "error") {
        stopped = true;
        clearInterval(timer);
      }
    };
    const timer = setInterval(poll, 1000);
    poll();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  if (status?.state === "ready") return <MapView status={status} />;
  return <ProgressCard status={status} fetchError={fetchError} />;
}
