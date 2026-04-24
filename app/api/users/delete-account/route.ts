import connectToDatabase from "@/lib/mongodb";
import { UserModel } from "@/lib/models";

// export async function GET() {
//   return Response.json({
//     message:
//       "This is a delete route for testing purposes. Use the same route with the DELETE method and provide email in request body to delete the user",
//   });
// }

export async function DELETE(req: Request) {
  try {
    await connectToDatabase();

    const body = await req.json();
    const email = body?.email;

    if (!email) {
      return Response.json(
        { error: "You must enter an email." },
        { status: 400 },
      );
    }

    const normalizedEmail = email.toLowerCase();

    const user = await UserModel.findOneAndDelete({ email: normalizedEmail });

    if (!user) {
      return Response.json({ error: "User not found" }, { status: 404 });
    }

    return Response.json({
      message: "Account deleted successfully",
    });
  } catch (error) {
    return Response.json(
      {
        error: "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}
