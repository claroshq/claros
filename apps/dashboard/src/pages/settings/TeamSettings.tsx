/**
 * Settings / Team.
 *
 * Workspace members, roles, and invites. Owners can promote, demote,
 * remove, and invite; members see the roster read-only. The invite link
 * panel covers installs without an email transport.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMe } from "../../auth.js";
import { fetchTeamMembers, createInvite, removeMember, changeRole } from "../../api.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Select } from "../../components/ui/select.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Section, formatDate } from "./shared.js";

export default function TeamSettings() {
  const qc = useQueryClient();
  const { data: meData } = useMe();
  const team = useQuery({ queryKey: ["team"], queryFn: fetchTeamMembers });
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const isOwner = meData?.user.role === "owner";
  const members = team.data?.members ?? [];

  const invite = useMutation({
    mutationFn: () => createInvite(inviteEmail, inviteRole),
    onSuccess: (data) => {
      setInviteUrl(data.invite.invite_url);
      setInviteEmail("");
      setInviteError(null);
      qc.invalidateQueries({ queryKey: ["team"] });
    },
    onError: (err) => { setInviteError(err instanceof Error ? err.message : "Failed"); },
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeMember(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["team"] }); },
  });

  const roleChange = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => changeRole(id, role),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["team"] }); },
  });

  return (
    <Section
      title="Team"
      configured={null}
      description="Everyone who can sign in to this install. Owners manage settings and members; members get read-only access here."
    >
      {team.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-left text-[15px]">
              <thead>
                <tr className="border-b border-border bg-sunken text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  <th className="px-4 py-2">Member</th>
                  <th className="px-4 py-2">Role</th>
                  <th className="px-4 py-2">Last login</th>
                  {isOwner && <th className="px-4 py-2 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5">
                      <p className="text-foreground">
                        {m.name || m.email}
                        {m.id === meData?.user.id && (
                          <span className="ml-2 text-[13px] text-muted-foreground">(you)</span>
                        )}
                      </p>
                      {m.name && <p className="text-[13px] text-muted-foreground">{m.email}</p>}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant="neutral">{m.role}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-[14px] text-muted-foreground">
                      {m.lastLoginAt ? formatDate(m.lastLoginAt) : "never"}
                    </td>
                    {isOwner && (
                      <td className="px-4 py-2.5 text-right">
                        {m.id !== meData?.user.id && (
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => roleChange.mutate({ id: m.id, role: m.role === "owner" ? "member" : "owner" })}
                              disabled={roleChange.isPending}
                            >
                              {m.role === "owner" ? "Demote" : "Promote"}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => { if (confirm(`Remove ${m.email}?`)) remove.mutate(m.id); }}
                              disabled={remove.isPending}
                            >
                              Remove
                            </Button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {isOwner && (
            <div className="mt-6 border-t border-border pt-5">
              <h3 className="text-[15px] font-medium text-foreground">Invite a team member</h3>
              <p className="mt-1 text-[14px] text-muted-foreground">
                An invite link is generated. It is emailed automatically when a transport is configured; otherwise share it directly.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="email@example.com"
                  className="max-w-xs"
                />
                <Select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className="w-auto">
                  <option value="member">Member</option>
                  <option value="owner">Owner</option>
                </Select>
                <Button size="sm" onClick={() => invite.mutate()} disabled={!inviteEmail || invite.isPending}>
                  {invite.isPending ? "Sending..." : "Send invite"}
                </Button>
              </div>
              {inviteUrl && (
                <div className="mt-3 rounded-md border border-border bg-sunken px-3.5 py-2.5">
                  <p className="mb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    Invite link
                  </p>
                  <p className="break-all font-mono text-[13px] text-foreground">{inviteUrl}</p>
                </div>
              )}
              {inviteError && <p className="mt-2 text-[14px] text-danger">{inviteError}</p>}
            </div>
          )}
        </>
      )}
    </Section>
  );
}
