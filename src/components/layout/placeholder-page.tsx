import type { ReactNode } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";

export function PlaceholderPage({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle: string;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-4 py-20 text-center">
          {icon ? <div className="text-primary">{icon}</div> : null}
          {children ? (
            <div className="max-w-md text-sm text-muted-foreground">{children}</div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
