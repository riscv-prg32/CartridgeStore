import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { changePassword } from "../../../lib/api/auth";

export function usePasswordSecurity() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const mutation = useMutation({
    mutationFn: () => changePassword(currentPassword, password, passwordConfirm),
    retry: false,
    onSuccess: () => { setCurrentPassword(""); setPassword(""); setPasswordConfirm(""); },
  });
  return { currentPassword, setCurrentPassword, password, setPassword, passwordConfirm, setPasswordConfirm, mutation };
}
