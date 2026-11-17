import { notFound } from "next/navigation";

import { UIShowcase } from "../../../components/foundation/UIShowcase";

export default function DevelopmentUIShowcasePage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <UIShowcase />;
}
