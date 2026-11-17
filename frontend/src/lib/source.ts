import { createElement } from "react";
import {
  Binary,
  Blocks,
  BookOpen,
  Cpu,
  GraduationCap,
  Store,
} from "lucide-react";
import { loader } from "fumadocs-core/source";

import { docs } from "../../.source/server";

const icons = {
  Binary,
  Blocks,
  BookOpen,
  Cpu,
  GraduationCap,
  Store,
};

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
  icon(name) {
    const Icon = name ? icons[name as keyof typeof icons] : undefined;
    return Icon ? createElement(Icon) : undefined;
  },
});
