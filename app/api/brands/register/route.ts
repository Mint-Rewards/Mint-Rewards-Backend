import { put } from "@vercel/blob";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel } from "@/lib/models";

const MAX_LOGO_SIZE_BYTES = 5 * 1024 * 1024;

function getFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function validateRequiredFields(payload: Record<string, string>) {
  const required = [
    "companyName",
    "brandName",
    "category",
    "website",
    "contactName",
    "contactPhone",
    "contactEmail",
    "registrationNumber",
  ];

  return required.filter((field) => !payload[field]);
}

export async function POST(req: Request) {
  try {
    await connectToDatabase();

    const formData = await req.formData();
    const payload = {
      companyName: getFormValue(formData, "companyName"),
      brandName: getFormValue(formData, "brandName"),
      category: getFormValue(formData, "category"),
      website: getFormValue(formData, "website"),
      appLink: getFormValue(formData, "appLink"),
      address: getFormValue(formData, "address"),
      description: getFormValue(formData, "description"),
      contactName: getFormValue(formData, "contactName"),
      contactPhone: getFormValue(formData, "contactPhone"),
      contactEmail: getFormValue(formData, "contactEmail"),
      registrationNumber: getFormValue(formData, "registrationNumber"),
      domain: getFormValue(formData, "domain"),
      themeColor: getFormValue(formData, "themeColor"),
    };

    const missing = validateRequiredFields(payload);
    if (missing.length > 0) {
      return Response.json(
        {
          success: false,
          message: "Missing required fields",
          fields: missing,
        },
        { status: 400 },
      );
    }

    let logoUrl = "";
    const logoFile = formData.get("logo");

    if (logoFile instanceof File) {
      if (!logoFile.type.startsWith("image/")) {
        return Response.json(
          { success: false, message: "Only image files are allowed" },
          { status: 400 },
        );
      }

      if (logoFile.size > MAX_LOGO_SIZE_BYTES) {
        return Response.json(
          { success: false, message: "Logo must be 5MB or smaller" },
          { status: 400 },
        );
      }

      const extension = logoFile.name.includes(".")
        ? `.${logoFile.name.split(".").pop()?.toLowerCase()}`
        : "";
      const uniqueName = `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}${extension || ".png"}`;
      const fileBuffer = Buffer.from(await logoFile.arrayBuffer());

      const blob = await put(`brands/${uniqueName}`, fileBuffer, {
        access: "public",
        contentType: logoFile.type || "application/octet-stream",
      });

      logoUrl = blob.url;
    }

    const normalizedEmail = payload.contactEmail.toLowerCase();

    const brand = await BrandModel.create({
      companyName: payload.companyName,
      brandName: payload.brandName,
      category: payload.category,
      webLink: payload.website,
      appLink: payload.appLink || "",
      address: payload.address || "",
      description: payload.description || "",
      contactName: payload.contactName,
      phone: payload.contactPhone,
      email: normalizedEmail,
      registrationNumber: payload.registrationNumber,
      domain: payload.domain || "",
      logo: logoUrl,
      themeColor: payload.themeColor || "#3B82F6",
      status: "PENDING",
    });

    return Response.json(
      {
        success: true,
        message: "Brand registration submitted successfully",
        brandId: brand._id,
        brand,
      },
      { status: 201 },
    );
  } catch (error: any) {
    if (error?.code === 11000) {
      return Response.json(
        {
          success: false,
          message:
            "A brand with this email or registration number already exists",
        },
        { status: 409 },
      );
    }

    return Response.json(
      {
        success: false,
        message: "Server error",
        error: error?.message || "Unexpected error",
      },
      { status: 500 },
    );
  }
}
