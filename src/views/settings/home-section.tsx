"use client";

import { LayoutGrid } from "lucide-react";
import { HOME_ROWS } from "@/lib/home-rows";
import { useProfilePreferences } from "@/lib/preferences-client";
import { Row, Section, Toggle } from "./primitives";

/** Which rows Home shows for this profile. Continue Watching and Top 10 always stay. */
export function HomeSection() {
  const { data, save } = useProfilePreferences();
  const hidden = new Set(data?.homeHidden ?? []);
  const setShown = (id: string, shown: boolean) => {
    const next = new Set(hidden);
    if (shown) next.delete(id);
    else next.add(id);
    void save({ homeHidden: [...next] });
  };
  return (
    <Section
      title="Home"
      icon={<LayoutGrid className="h-4 w-4 text-white/70" />}
      description="Choose the rows on your Home page. Continue Watching and Top 10 always stay."
    >
      {HOME_ROWS.map((row) => (
        <Row key={row.id} inline label={row.label}>
          <Toggle label={`Show ${row.label}`} checked={!hidden.has(row.id)} disabled={!data} onChange={(on) => setShown(row.id, on)} />
        </Row>
      ))}
      {hidden.size > 0 && (
        <div className="flex justify-end pt-3">
          <button
            type="button"
            onClick={() => void save({ homeHidden: [] })}
            className="h-9 rounded-full bg-white/10 px-4 text-xs font-semibold text-white transition hover:bg-white/15"
          >
            Show every row
          </button>
        </div>
      )}
    </Section>
  );
}
