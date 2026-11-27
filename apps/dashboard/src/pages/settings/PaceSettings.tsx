/**
 * Settings / Sending pace.
 *
 * Per-contact caps, the send window, and the drain batch size. These
 * limits protect sender reputation; getting them wrong lands mail in
 * spam or gets the domain blocked.
 */
import React, { useEffect, useState } from "react";
import { useThrottle, usePutThrottle } from "../../settings.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Select } from "../../components/ui/select.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Section, FormError, SummaryList, SummaryItem, errorMessage } from "./shared.js";

export default function PaceSettings() {
  const throttleQuery = useThrottle();
  const throttle = throttleQuery.data?.throttle;
  const isThrottleLoading = throttleQuery.isLoading;
  const put = usePutThrottle();
  const [open, setOpen] = useState(false);
  const [maxPerDay, setMaxPerDay] = useState("");
  const [maxPerWeek, setMaxPerWeek] = useState("");
  const [minInterval, setMinInterval] = useState("");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [windowDays, setWindowDays] = useState<string[]>([]);
  const [timezoneMode, setTimezoneMode] = useState<"contact_local" | "tenant_fixed">("contact_local");
  const [tenantTimezone, setTenantTimezone] = useState("");
  const [batchSize, setBatchSize] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!throttle || initialized) return;
    setMaxPerDay(String(throttle.max_emails_per_user_per_day));
    setMaxPerWeek(String(throttle.max_emails_per_user_per_week));
    setMinInterval(String(throttle.min_interval_between_emails_hours));
    setWindowStart(throttle.send_window_start);
    setWindowEnd(throttle.send_window_end);
    setWindowDays([...throttle.send_window_days]);
    setTimezoneMode(throttle.send_window_timezone);
    setTenantTimezone(throttle.tenant_timezone ?? "");
    setBatchSize(String(throttle.batch_size_per_tick));
    setInitialized(true);
  }, [throttle, initialized]);

  if (isThrottleLoading || !throttle) return <Skeleton className="h-48 w-full" />;

  const dayOptions = [
    { value: "mon", label: "Mon" },
    { value: "tue", label: "Tue" },
    { value: "wed", label: "Wed" },
    { value: "thu", label: "Thu" },
    { value: "fri", label: "Fri" },
    { value: "sat", label: "Sat" },
    { value: "sun", label: "Sun" },
  ];

  function toggleDay(day: string) {
    if (windowDays.includes(day)) {
      setWindowDays(windowDays.filter((d) => d !== day));
    } else {
      setWindowDays([...windowDays, day]);
    }
    setSaved(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await put.mutateAsync({
        max_emails_per_user_per_day: maxPerDay === "" ? undefined : Number(maxPerDay),
        max_emails_per_user_per_week: maxPerWeek === "" ? undefined : Number(maxPerWeek),
        min_interval_between_emails_hours: minInterval === "" ? undefined : Number(minInterval),
        send_window_start: windowStart || undefined,
        send_window_end: windowEnd || undefined,
        send_window_days: windowDays as Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">,
        send_window_timezone: timezoneMode,
        tenant_timezone: tenantTimezone || undefined,
        batch_size_per_tick: batchSize === "" ? undefined : Number(batchSize),
      });
      setOpen(false);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Section
      title="Sending pace"
      configured={true}
      description="How fast email leaves your relay and when it is allowed to send. These limits protect your sender reputation - getting them wrong lands you in spam or gets the domain blocked."
      actions={
        !open ? (
          <Button variant="outline" size="sm" onClick={() => { setOpen(true); setSaved(false); }}>
            Modify
          </Button>
        ) : undefined
      }
    >
      {!open && (
        <>
          <SummaryList>
            <SummaryItem label="Max per contact / day" mono>{throttle.max_emails_per_user_per_day}</SummaryItem>
            <SummaryItem label="Max per contact / week" mono>{throttle.max_emails_per_user_per_week}</SummaryItem>
            <SummaryItem label="Min gap between emails" mono>{throttle.min_interval_between_emails_hours} hours</SummaryItem>
            <SummaryItem label="Batch size per tick" mono>{throttle.batch_size_per_tick} messages</SummaryItem>
            <SummaryItem label="Send window" mono span>
              {throttle.send_window_start} - {throttle.send_window_end} ({throttle.send_window_days.join(", ")})
              {" via "}
              {throttle.send_window_timezone === "contact_local" ? "contact timezone" : `tenant timezone (${throttle.tenant_timezone ?? "not set"})`}
            </SummaryItem>
          </SummaryList>
        </>
      )}

      {saved && !open && (
        <p className="mt-3 text-[15px] text-success" role="status">Saved.</p>
      )}

      {open && (
        <form onSubmit={handleSubmit} noValidate className="mt-2 space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label htmlFor="th-daily" className="mb-1.5 block text-[16px] font-medium text-foreground">
                Max per contact per day
              </label>
              <Input
                id="th-daily"
                type="number"
                min={0}
                max={100}
                value={maxPerDay}
                onChange={(e) => { setMaxPerDay(e.target.value); setSaved(false); }}
                disabled={put.isPending}
              />
              <p className="mt-1 text-[14px] text-muted-foreground">0 = no limit, 100 = max</p>
            </div>
            <div>
              <label htmlFor="th-weekly" className="mb-1.5 block text-[16px] font-medium text-foreground">
                Max per contact per week
              </label>
              <Input
                id="th-weekly"
                type="number"
                min={0}
                max={500}
                value={maxPerWeek}
                onChange={(e) => { setMaxPerWeek(e.target.value); setSaved(false); }}
                disabled={put.isPending}
              />
              <p className="mt-1 text-[14px] text-muted-foreground">0 = no limit, 500 = max</p>
            </div>
            <div>
              <label htmlFor="th-interval" className="mb-1.5 block text-[16px] font-medium text-foreground">
                Minimum gap (hours)
              </label>
              <Input
                id="th-interval"
                type="number"
                min={0}
                max={168}
                value={minInterval}
                onChange={(e) => { setMinInterval(e.target.value); setSaved(false); }}
                disabled={put.isPending}
              />
              <p className="mt-1 text-[14px] text-muted-foreground">0 = no minimum, 168 = 1 week</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label htmlFor="th-window-start" className="mb-1.5 block text-[16px] font-medium text-foreground">
                Window start
              </label>
              <Input
                id="th-window-start"
                type="time"
                value={windowStart}
                onChange={(e) => { setWindowStart(e.target.value); setSaved(false); }}
                disabled={put.isPending}
              />
            </div>
            <div>
              <label htmlFor="th-window-end" className="mb-1.5 block text-[16px] font-medium text-foreground">
                Window end
              </label>
              <Input
                id="th-window-end"
                type="time"
                value={windowEnd}
                onChange={(e) => { setWindowEnd(e.target.value); setSaved(false); }}
                disabled={put.isPending}
              />
            </div>
            <div>
              <label htmlFor="th-batch" className="mb-1.5 block text-[16px] font-medium text-foreground">
                Batch size per tick
              </label>
              <Input
                id="th-batch"
                type="number"
                min={1}
                max={100}
                value={batchSize}
                onChange={(e) => { setBatchSize(e.target.value); setSaved(false); }}
                disabled={put.isPending}
              />
            </div>
          </div>

          <div>
            <label className="mb-2 block text-[16px] font-medium text-foreground">Send days</label>
            <div className="flex flex-wrap gap-2">
              {dayOptions.map((day) => (
                <label key={day.value} className="flex items-center gap-1.5 text-[16px] text-foreground">
                  <input
                    type="checkbox"
                    checked={windowDays.includes(day.value)}
                    onChange={() => toggleDay(day.value)}
                    disabled={put.isPending}
                    className="rounded border-input"
                  />
                  {day.label}
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="th-tz-mode" className="mb-1.5 block text-[16px] font-medium text-foreground">
                Timezone for send window
              </label>
              <Select
                id="th-tz-mode"
                value={timezoneMode}
                onChange={(e) => { setTimezoneMode(e.target.value as "contact_local" | "tenant_fixed"); setSaved(false); }}
                disabled={put.isPending}
              >
                <option value="contact_local">Contact local time</option>
                <option value="tenant_fixed">Tenant fixed timezone</option>
              </Select>
            </div>
            {timezoneMode === "tenant_fixed" && (
              <div>
                <label htmlFor="th-tenant-tz" className="mb-1.5 block text-[16px] font-medium text-foreground">
                  Tenant timezone
                </label>
                <Input
                  id="th-tenant-tz"
                  value={tenantTimezone}
                  onChange={(e) => { setTenantTimezone(e.target.value); setSaved(false); }}
                  placeholder="America/New_York"
                  disabled={put.isPending}
                />
              </div>
            )}
          </div>

          <FormError message={error} />
          <div className="flex items-center gap-3 pt-1">
            <Button type="submit" disabled={put.isPending}>
              {put.isPending ? "Saving..." : "Save"}
            </Button>
            <Button type="button" variant="ghost" disabled={put.isPending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}
