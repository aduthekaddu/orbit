import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function Row({
  id,
  label,
  labelledControl = true,
  className,
  children,
}: {
  id: string;
  label: string;
  labelledControl?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid gap-2 px-5 py-3.5 sm:grid-cols-[7rem_1fr] sm:items-center sm:gap-4", className)}>
      <Label id={`${id}-label`} htmlFor={labelledControl ? id : undefined} className="text-meta text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
