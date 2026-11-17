"use client";

import type { Principal } from "../../../lib/api/contracts";
import { authErrorMessage } from "../../../lib/api/auth";
import { Button } from "../../ui/button";
import { Field } from "../../ui/input";
import { StatusMessage } from "../../ui/status";
import { useProfile } from "./use-profile";

export function ProfileDetailsPanel({ user }: { user: Principal }) {
  const profile = useProfile(user);

  return (
    <section
      aria-labelledby="profile-details-heading"
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-card)] sm:p-6"
    >
      <div className="flex flex-col justify-between gap-2 border-b border-[var(--color-border)] pb-5 sm:flex-row sm:items-start">
        <div>
          <p className="technical-label text-[var(--color-primary)]">Profile</p>
          <h2 id="profile-details-heading" className="mt-1 text-lg font-bold">
            Personal details
          </h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Choose how your account appears across the Cartridge Store.
          </p>
        </div>
        <span className="text-xs text-[var(--color-text-muted)]">Account identity</span>
      </div>

      <form
        className="mt-5 grid gap-4 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          profile.save.mutate();
        }}
      >
        <Field
          label="Display name"
          name="display_name"
          value={profile.displayName}
          maxLength={160}
          autoComplete="name"
          help="This is the name other people see in the Store."
          onChange={(event) => profile.setDisplayName(event.target.value)}
        />
        <Field
          label="Email"
          name="email"
          type="email"
          value={user.email}
          readOnly
          help="Email changes require a separate verification flow."
          className="[&_input]:bg-[var(--color-surface-muted)]"
        />
        <Field
          label="Username"
          name="username"
          value={user.username}
          readOnly
          className="[&_input]:bg-[var(--color-surface-muted)]"
        />
        <div className="flex items-end sm:justify-end">
          <Button
            type="submit"
            loading={profile.save.isPending}
            disabled={!profile.displayName.trim() || profile.save.isPending}
          >
            Save profile
          </Button>
        </div>
      </form>

      {profile.save.error && (
        <StatusMessage tone="danger" className="mt-4">
          {authErrorMessage(profile.save.error, "profile")}
        </StatusMessage>
      )}
      {profile.save.isSuccess && (
        <StatusMessage tone="success" className="mt-4">
          Profile updated.
        </StatusMessage>
      )}
    </section>
  );
}
