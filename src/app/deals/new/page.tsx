import { requireUser } from "@/lib/auth";
import { NewDealForm } from "./NewDealForm";

export default async function NewDealPage() {
  await requireUser("/deals/new");
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">New protected deal</h1>
        <p className="text-sm text-stone-600">
          Split the job into stages. Your client locks the money for each stage before you start it.
        </p>
      </div>
      <NewDealForm />
    </div>
  );
}
