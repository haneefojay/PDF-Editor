import { Buffer } from "buffer";
import { PDFDocument } from "pdf-lib";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { P12Signer } from "@signpdf/signer-p12";
import { SignPdf } from "@signpdf/signpdf";

type SignatureDetails = {
  reason: string;
  name: string;
  location: string;
  contactInfo: string;
};

export async function signPdfWithCertificate(
  pdf: Uint8Array,
  certificate: Uint8Array,
  passphrase: string,
  details: SignatureDetails,
) {
  (globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer =
    Buffer;
  const document = await PDFDocument.load(pdf, { updateMetadata: false });
  pdflibAddPlaceholder({
    pdfDoc: document,
    reason: details.reason,
    name: details.name,
    location: details.location,
    contactInfo: details.contactInfo,
    signingTime: new Date(),
    signatureLength: 16_384,
    appName: "Paperless PDF Editor",
  });
  const prepared = await document.save({
    useObjectStreams: false,
    addDefaultPage: false,
    updateFieldAppearances: false,
  });
  const signer = new P12Signer(Buffer.from(certificate), { passphrase });
  const signed = await new SignPdf().sign(
    Buffer.from(prepared),
    signer,
    new Date(),
  );
  return new Uint8Array(signed);
}
