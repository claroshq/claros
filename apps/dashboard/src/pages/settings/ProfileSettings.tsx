/**
 * Settings / Profile.
 *
 * The signed-in user's own account: display name, role, and the
 * email-change request flow (a verification link goes to the new
 * address before anything switches).
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchProfile, updateProfile, requestEmailChange } from "../../api.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Section, SummaryList, SummaryItem, Notice } from "./shared.js";

export default function ProfileSettings() {
  const qc = useQueryClient();
  const profile = useQuery({ queryKey: ["profile"], queryFn: fetchProfile });
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [emailMsg, setEmailMsg] = useState<string | null>(null);

  const saveName = useMutation({
    mutationFn: (n: string | null) => updateProfile({ name: n }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["profile"] }); setEditingName(false); },
  });

  const requestEmail = useMutation({
    mutationFn: (email: string) => requestEmailChange(email),
    onSuccess: (data) => {
      setEmailMsg(data.message);
      setNewEmail("");
      qc.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: (err) => { setEmailMsg(err instanceof Error ? err.message : "Failed"); },
  });

  const p = profile.data?.profile;

  if (profile.isLoading || !p) {
    return (
      <Section title="Profile" configured={null}>
        <Skeleton className="h-20 w-full" />
      </Section>
    );
  }

  return (
    <Section
      title="Profile"
      configured={null}
      description="Your account on this install. The display name appears in the team roster; the email is how you sign in."
    >
      <SummaryList>
        <SummaryItem label="Email">
          <span className="flex items-center gap-2">
            {p.email}
            <Badge variant="neutral">{p.role}</Badge>
          </span>
        </SummaryItem>
        <SummaryItem label="Name">
          {editingName ? (
            <span className="flex items-center gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Display name"
                className="h-8 max-w-56"
                autoFocus
              />
              <Button size="sm" onClick={() => saveName.mutate(name || null)} disabled={saveName.isPending}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditingName(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <span className="flex items-center gap-2">
              {p.name || <span className="text-muted-foreground">Not set</span>}
              <Button size="sm" variant="ghost" onClick={() => { setName(p.name ?? ""); setEditingName(true); }}>
                Edit
              </Button>
            </span>
          )}
        </SummaryItem>
      </SummaryList>

      {p.pending_email && (
        <Notice variant="info" className="mt-4">
          A change to <span className="font-mono text-[13px]">{p.pending_email}</span> is
          pending. Your login switches once you confirm from that inbox.
        </Notice>
      )}

      <div className="mt-6 border-t border-border pt-5">
        <h3 className="text-[14px] font-medium text-foreground">Change login email</h3>
        <p className="mt-1 text-[13px] text-muted-foreground">
          A verification link goes to the new address. Nothing switches until you confirm.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="new@email.com"
            className="max-w-xs"
          />
          <Button
            size="sm"
            onClick={() => requestEmail.mutate(newEmail)}
            disabled={!newEmail || requestEmail.isPending}
          >
            Request change
          </Button>
        </div>
        {emailMsg && <p className="mt-2 text-[13px] text-muted-foreground" role="status">{emailMsg}</p>}
      </div>
    </Section>
  );
}
