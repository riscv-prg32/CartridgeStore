"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  authorizeSetup,
  completeSetup,
  getSetupProgress,
  getSetupStatus,
  saveSetupStep,
  type SetupProgress,
  type SetupStatus,
} from "../../lib/api/setup";
import {
  payloadFor,
  setupErrorMessage,
  type SetupFormState as FormState,
} from "./setup-form";
import { setupSteps } from "./setup-steps";

/** Owns setup wizard state and step transitions. */
export function useSetupWizard() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [token, setToken] = useState("");
  const [current, setCurrent] = useState(0);
  const [form, setForm] = useState<FormState>({ enabled: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [fatal, setFatal] = useState("");
  const router = useRouter();

  useEffect(() => {
    void getSetupStatus()
      .then(setStatus)
      .catch((error) => setFatal(setupErrorMessage(error)));
  }, []);

  useEffect(() => {
    if (!status?.setup_required || status.state === "INFRASTRUCTURE_NOT_READY") {
      return;
    }
    void getSetupProgress()
      .then((value) => {
        setProgress(value);
        const first = setupSteps.findIndex((step) =>
          !value.completed_steps.includes(step.id),
        );
        setCurrent(first < 0 ? setupSteps.length - 1 : first);
      })
      .catch(() => {
        // The authorization screen is expected before progress.
      });
  }, [status]);

  const activeStep = setupSteps[current] ?? setupSteps[0]!;
  const completed = useMemo(
    () => new Set(progress?.completed_steps ?? []),
    [progress],
  );
  const authorized = Boolean(progress);

  const update = (name: string, value: string | boolean) => {
    setForm((previous) => ({ ...previous, [name]: value }));
  };

  async function authorize() {
    setBusy(true);
    setMessage("");
    try {
      const result = await authorizeSetup(token);
      setProgress(result);
      setToken("");
      setMessage(
        "Installation session authorized. The token is not stored in this browser.",
      );
    } catch (error) {
      setMessage(setupErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveCurrent() {
    if (!progress) return;
    setBusy(true);
    setMessage("");
    try {
      const next = await saveSetupStep(
        progress.csrf_token,
        activeStep.id,
        payloadFor(activeStep.id, form),
      );
      setProgress(next);
      if (activeStep.id === "admin") setForm({});
      if (activeStep.id === "smtp") {
        setForm((previous) => ({ ...previous, smtp_password: "" }));
      }
      const nextIndex = setupSteps.findIndex((step) =>
        !next.completed_steps.includes(step.id),
      );
      setCurrent(nextIndex < 0 ? setupSteps.length - 1 : nextIndex);
      setMessage(`${activeStep.label} saved.`);
    } catch (error) {
      setMessage(setupErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!progress) return;
    setBusy(true);
    setMessage("");
    try {
      const reviewed = await saveSetupStep(progress.csrf_token, "review", {});
      setProgress(reviewed);
      await completeSetup(reviewed.csrf_token);
      router.push("/login");
    } catch (error) {
      setMessage(setupErrorMessage(error));
      setBusy(false);
    }
  }

  async function skipCurrent() {
    if (!progress) return;
    setBusy(true);
    setMessage("");
    try {
      const next = await saveSetupStep(
        progress.csrf_token,
        activeStep.id,
        { enabled: false },
      );
      setProgress(next);
      const nextIndex = setupSteps.findIndex((step) =>
        !next.completed_steps.includes(step.id),
      );
      setCurrent(nextIndex < 0 ? setupSteps.length - 1 : nextIndex);
      setMessage(`${activeStep.label} skipped.`);
    } catch (error) {
      setMessage(setupErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return {
    status,
    progress,
    token,
    setToken,
    current,
    setCurrent,
    form,
    busy,
    message,
    fatal,
    activeStep,
    completed,
    authorized,
    update,
    authorize,
    saveCurrent,
    finish,
    skipCurrent,
  };
}
