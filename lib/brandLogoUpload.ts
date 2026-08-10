import { put } from "@vercel/blob";

export const MAX_LOGO_BYTES = 5 * 1024 * 1024; // 5 MB — matches registration's limit

export type LogoUploadError = { message: string; status: number };

/**
 * Validates and uploads a brand logo to blob storage. Shared by the brand-side
 * PATCH /api/brandhub/brands/[brandId] and the admin-side PATCH /api/brands/[id]
 * so both enforce identical limits and produce identically-keyed blobs.
 *
 * Returns the public URL, or a `{ message, status }` the caller turns into a
 * JSON error response.
 */
export async function uploadBrandLogo(
  brandId: string,
  logoFile: File,
): Promise<string | LogoUploadError> {
  if (!logoFile.type.startsWith("image/")) {
    return { message: "Logo must be an image file", status: 400 };
  }
  if (logoFile.size > MAX_LOGO_BYTES) {
    return { message: "Logo must be 5MB or smaller", status: 400 };
  }

  const extension = logoFile.name.includes(".")
    ? `.${logoFile.name.split(".").pop()?.toLowerCase()}`
    : "";

  const blob = await put(
    `brands/${brandId}/logo-${Date.now()}${extension || ".png"}`,
    Buffer.from(await logoFile.arrayBuffer()),
    {
      access: "public",
      contentType: logoFile.type || "application/octet-stream",
      token: process.env.BLOB_PUBLIC_READ_WRITE_TOKEN,
    },
  );

  return blob.url;
}

export function isLogoUploadError(
  value: string | LogoUploadError,
): value is LogoUploadError {
  return typeof value !== "string";
}
