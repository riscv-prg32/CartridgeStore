import { DOMParser, type Document, type Element, type Node } from "@xmldom/xmldom";
import { SignedXml, type Reference } from "xml-crypto";

const XMLDSIG_NAMESPACE = "http://www.w3.org/2000/09/xmldsig#";

export type SamlSignatureFailure =
  | "none"
  | "missing"
  | "multiple"
  | "reference_count"
  | "reference_target"
  | "duplicate_id"
  | "digest"
  | "signature_value"
  | "algorithm"
  | "certificate"
  | "other";

export interface SamlSignatureLocationDiagnostic {
  readonly location: "response" | "assertion";
  readonly signatureCount: number;
  readonly referenceCount: number;
  readonly referenceUri: "empty" | "fragment" | "other" | "none";
  readonly referenceTargetCount: number;
  readonly referenceTargetsParent: boolean;
  readonly transformCount: number;
  readonly signatureAlgorithm: string;
  readonly digestAlgorithm: string;
  readonly canonicalizationAlgorithm: string;
  readonly result: "verified" | "rejected";
  readonly failure: SamlSignatureFailure;
}

export interface SamlSignatureDiagnostics {
  readonly response: SamlSignatureLocationDiagnostic;
  readonly assertion: SamlSignatureLocationDiagnostic;
  readonly certificateCandidates: number;
}

function elements(node: Node | null | undefined): Element[] {
  if (!node) return [];
  const result: Element[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) result.push(child as Element);
  }
  return result;
}

function signatures(parent: Element): Element[] {
  return elements(parent).filter((item) => item.localName === "Signature" && item.namespaceURI === XMLDSIG_NAMESPACE);
}

function allElements(node: Node): Element[] {
  const result: Element[] = [];
  const visit = (current: Node): void => {
    if (current.nodeType === 1) result.push(current as Element);
    for (let child = current.firstChild; child; child = child.nextSibling) visit(child);
  };
  visit(node);
  return result;
}

function shortAlgorithm(value: string | undefined): string {
  if (!value) return "none";
  if (value.includes("rsa-sha256")) return "rsa-sha256";
  if (value.includes("rsa-sha512")) return "rsa-sha512";
  if (value.includes("rsa-sha1")) return "rsa-sha1";
  if (value.includes("sha256")) return "sha256";
  if (value.includes("sha512")) return "sha512";
  if (value.includes("sha1")) return "sha1";
  if (value.includes("exc-c14n")) return "exclusive-c14n";
  if (value.includes("c14n")) return "c14n";
  return "other";
}

function failureFromMessage(message: string): SamlSignatureFailure {
  if (/digest|reference.*find|could not find such element|references/i.test(message)) return "digest";
  if (/signature value|signature.*incorrect|invalid signature|verifySignature/i.test(message)) return "signature_value";
  if (/algorithm|transform|canonical/i.test(message)) return "algorithm";
  if (/certificate|key/i.test(message)) return "certificate";
  return "other";
}

function referenceUriKind(reference: Reference | undefined): "empty" | "fragment" | "other" | "none" {
  if (!reference) return "none";
  if (reference.uri === "") return "empty";
  if (reference.uri.startsWith("#")) return "fragment";
  return "other";
}

function inspectLocation(
  location: "response" | "assertion",
  parent: Element | null,
  xml: string,
  trustedCertificates: readonly string[],
  document: Document,
): SamlSignatureLocationDiagnostic {
  const found = parent ? signatures(parent) : [];
  const signatureCount = found.length;
  const base: SamlSignatureLocationDiagnostic = {
    location,
    signatureCount,
    referenceCount: 0,
    referenceUri: "none",
    referenceTargetCount: 0,
    referenceTargetsParent: false,
    transformCount: 0,
    signatureAlgorithm: "none",
    digestAlgorithm: "none",
    canonicalizationAlgorithm: "none",
    result: "rejected",
    failure: "missing"
  };
  if (signatureCount === 0) return base;
  if (signatureCount !== 1 || !parent) return { ...base, failure: "multiple" };

  const signature = found[0];
  if (!signature) return { ...base, failure: "missing" };
  const signedInfo = elements(signature).find((item) => item.localName === "SignedInfo" && item.namespaceURI === XMLDSIG_NAMESPACE);
  const signatureMethod = signedInfo?.getElementsByTagNameNS(XMLDSIG_NAMESPACE, "SignatureMethod")[0];
  const canonicalizationMethod = signedInfo?.getElementsByTagNameNS(XMLDSIG_NAMESPACE, "CanonicalizationMethod")[0];
  const transformCount = signature.getElementsByTagNameNS(XMLDSIG_NAMESPACE, "Transform").length;
  let reference: Reference | undefined;
  let referenceCount = 0;
  let referenceTargetCount = 0;
  let referenceTargetsParent = false;
  let failure: SamlSignatureFailure = "other";

  try {
    const verifier = new SignedXml();
    verifier.publicCert = trustedCertificates[0] ?? "";
    verifier.loadSignature(signature);
    const references = verifier.getReferences();
    referenceCount = references.length;
    reference = references[0];
    if (reference) {
      const id = reference.uri.startsWith("#") ? reference.uri.slice(1) : reference.uri;
      const targets = id === "" ? [] : allElements(document).filter((item) => item.getAttribute("ID") === id);
      referenceTargetCount = targets.length;
      referenceTargetsParent = targets.length === 1 && targets[0] === parent;
      if (referenceCount !== 1) failure = "reference_count";
      else if (targets.length === 0 || !referenceTargetsParent) failure = targets.length > 1 ? "duplicate_id" : "reference_target";
    } else {
      failure = "reference_count";
    }

    if (failure === "other") {
      for (const certificate of trustedCertificates) {
        const candidate = new SignedXml();
        candidate.publicCert = certificate;
        candidate.loadSignature(signature);
        try {
          if (candidate.checkSignature(xml.replace(/\r\n?/g, "\n"))) {
            return {
              ...base,
              referenceCount,
              referenceUri: referenceUriKind(reference),
              referenceTargetCount,
              referenceTargetsParent,
              transformCount,
              signatureAlgorithm: shortAlgorithm((candidate as unknown as { signatureAlgorithm?: string }).signatureAlgorithm),
              digestAlgorithm: shortAlgorithm(reference?.digestAlgorithm),
              canonicalizationAlgorithm: shortAlgorithm((candidate as unknown as { canonicalizationAlgorithm?: string }).canonicalizationAlgorithm),
              result: "verified",
              failure: "none"
            };
          }
        } catch (error) {
          failure = failureFromMessage(error instanceof Error ? error.message : "");
        }
        const validationError = candidate.getReferences()[0]?.validationError;
        if (validationError) failure = failureFromMessage(validationError.message);
      }
    }
  } catch (error) {
    failure = failureFromMessage(error instanceof Error ? error.message : "");
  }

  return {
    ...base,
    referenceCount,
    referenceUri: referenceUriKind(reference),
    referenceTargetCount,
    referenceTargetsParent,
    transformCount,
    signatureAlgorithm: shortAlgorithm(signatureMethod?.getAttribute("Algorithm") ?? undefined),
    digestAlgorithm: shortAlgorithm(reference?.digestAlgorithm),
    canonicalizationAlgorithm: shortAlgorithm(canonicalizationMethod?.getAttribute("Algorithm") ?? undefined),
    failure
  };
}

export function diagnoseSamlSignature(value: string, trustedCertificates: readonly string[]): SamlSignatureDiagnostics | null {
  try {
    const xml = Buffer.from(value, "base64").toString("utf8");
    const document = new DOMParser({ errorHandler: () => undefined }).parseFromString(xml, "text/xml");
    const root = document.documentElement;
    if (!root || root.localName !== "Response") return null;
    const assertion = elements(root).find((item) => item.localName === "Assertion") ?? null;
    return {
      response: inspectLocation("response", root, xml, trustedCertificates, document),
      assertion: inspectLocation("assertion", assertion, xml, trustedCertificates, document),
      certificateCandidates: trustedCertificates.length
    };
  } catch {
    return null;
  }
}

export function signatureDiagnosticCode(value: string, trustedCertificates: readonly string[]): string | null {
  const diagnostic = diagnoseSamlSignature(value, trustedCertificates);
  if (!diagnostic) return null;
  const compact = (item: SamlSignatureLocationDiagnostic): string => [
    `${item.result}:${item.failure}`,
    `refs=${item.referenceCount}`,
    `uri=${item.referenceUri}`,
    `targets=${item.referenceTargetCount}`,
    `parent=${item.referenceTargetsParent ? "yes" : "no"}`,
    `transforms=${item.transformCount}`,
    `sig=${item.signatureAlgorithm}`,
    `digest=${item.digestAlgorithm}`,
    `c14n=${item.canonicalizationAlgorithm}`
  ].join(";");
  return `response=${compact(diagnostic.response)}|assertion=${compact(diagnostic.assertion)}|certs=${diagnostic.certificateCandidates}`;
}
