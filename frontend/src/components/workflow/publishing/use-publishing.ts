"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { submitBundle } from "../../../lib/api/workflow";
import { validateBundleFile } from "./publishing-validation";

export function usePublishing() {
  const [step, setStep] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const submission = useMutation({ mutationFn: (bundle: File) => submitBundle(bundle), retry: false });

  function selectFile(candidate: File | undefined) {
    setFileError(null);
    submission.reset();
    if (!candidate) {
      setFile(null);
      return;
    }
    const error = validateBundleFile(candidate);
    if (error) {
      setFile(null);
      setFileError(error);
      return;
    }
    setFile(candidate);
  }

  function reset() {
    submission.reset();
    setFile(null);
    setFileError(null);
    setStep(1);
  }

  return { step, setStep, file, fileError, submission, selectFile, reset };
}

export type PublishingState = ReturnType<typeof usePublishing>;
