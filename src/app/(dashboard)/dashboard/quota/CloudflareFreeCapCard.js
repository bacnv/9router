"use client";

import { useEffect, useState } from "react";
import Card from "@/shared/components/Card";
import Toggle from "@/shared/components/Toggle";

/**
 * Toggle for the Cloudflare Workers AI daily free-neuron cap.
 *
 * Off (default) bills overage like any Workers Paid usage; on refuses the
 * connection once the day's 10,000 free neurons are spent. The per-connection
 * count itself renders below, from the usage handler.
 */
export default function CloudflareFreeCapCard() {
  const [enabled, setEnabled] = useState(null);
  const [hasConnection, setHasConnection] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/settings").then((r) => r.json()),
      fetch("/api/providers").then((r) => r.json()),
    ])
      .then(([settings, providers]) => {
        setEnabled(settings.cloudflareFreeOnly === true);
        const connections = providers.connections || [];
        setHasConnection(
          connections.some((c) => c.provider === "cloudflare-ai")
        );
      })
      .catch(() => setEnabled(null));
  }, []);

  const handleToggle = async (value) => {
    const previous = enabled;
    setEnabled(value);
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cloudflareFreeOnly: value }),
      });
      if (!res.ok) setEnabled(previous);
    } catch {
      setEnabled(previous);
    } finally {
      setSaving(false);
    }
  };

  // Nothing to show until settings load, or for anyone not using Cloudflare.
  if (enabled === null || !hasConnection) return null;

  return (
    <Card
      title="Cloudflare free tier"
      subtitle="Workers Paid keeps serving past the daily free allocation and bills the overage. This stops it instead."
      icon="savings"
      padding="md"
    >
      <Toggle
        checked={enabled}
        disabled={saving}
        onChange={handleToggle}
        label="Stop at the free allocation"
        description="Skip Cloudflare once 10,000 neurons are spent for the day. Resets 00:00 UTC (07:00 Vietnam time)."
      />
    </Card>
  );
}
