/**
 * Settings / Postal address.
 *
 * A physical postal address is a legal requirement on commercial email
 * (CAN-SPAM). While it is missing, the drain refuses to send anything.
 */
import React, { useState } from "react";
import { useSetupState, usePatchTenant } from "../../settings.js";
import { Button } from "../../components/ui/button.js";
import { Textarea } from "../../components/ui/textarea.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Section, FormError, Notice, errorMessage } from "./shared.js";

export default function PostalSettings() {
  const { tenant, isLoading } = useSetupState();
  const patch = usePatchTenant();
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (isLoading || !tenant) return <Skeleton className="h-32 w-full" />;

  const current = value ?? tenant.postal_address ?? "";
  const configured = (tenant.postal_address ?? "") !== "";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await patch.mutateAsync({ postal_address: current });
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Section
      title="Postal address"
      configured={configured}
      description="A physical postal address is a legal requirement on commercial email (CAN-SPAM). It appears in the footer of every message the product sends."
    >
      {!configured && (
        <Notice className="mb-4">
          Outgoing mail is blocked until this is set. The drain refuses to send anything.
        </Notice>
      )}
      <form onSubmit={handleSubmit} noValidate>
        <Textarea
          aria-label="Postal address"
          rows={4}
          value={current}
          onChange={(e) => { setValue(e.target.value); setSaved(false); }}
          placeholder={"Company name\nStreet address\nCity, State, ZIP\nCountry"}
          disabled={patch.isPending}
        />
        <FormError message={error} />
        <div className="mt-3 flex items-center gap-3">
          <Button type="submit" size="sm" disabled={patch.isPending || current.trim().length === 0}>
            {patch.isPending ? "Saving..." : "Save address"}
          </Button>
          {saved && (
            <span className="text-[15px] text-success" role="status">Saved.</span>
          )}
        </div>
      </form>
    </Section>
  );
}
