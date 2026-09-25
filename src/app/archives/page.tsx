"use client";

/**
 * Archives (Phase 6 Stage D) — read-only searchable history.
 *
 * Search by text (task title/description, artifact/agent-message content),
 * house, status, and type over terminal tasks. Paginated (Q6: default 25, cap
 * 100) with `total` exposed. No writer, no FTS5 (Q5) — this page only reads
 * `/api/archives`.
 *
 * Archives already has a nav slot (`NAV_SECTIONS`), so no nav change is needed.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Library, Search, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch } from "@/lib/api-client";
import { TaskStatusBadge } from "@/components/houses/task-status-badge";
import type { ArchiveEntryDto, HouseDto, TaskStatus } from "@/shared/types";

const PAGE_SIZE = 25;
const ALL = "all";
const STATUSES: readonly TaskStatus[] = ["completed", "failed", "cancelled", "interrupted"];

export default function ArchivesPage() {
  const [entries, setEntries] = useState<ArchiveEntryDto[]>([]);
  const [total, setTotal] = useState(0);
  const [houses, setHouses] = useState<HouseDto[]>([]);
  const [loading, setLoading] = useState(true);

  const [query, setQuery] = useState("");
  const [houseId, setHouseId] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);
  const [page, setPage] = useState(0);

  const load = useCallback(
    async (opts: { q: string; houseId: string; status: string; page: number }) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (opts.q.trim()) params.set("q", opts.q.trim());
        if (opts.houseId !== ALL) params.set("houseId", opts.houseId);
        if (opts.status !== ALL) params.set("status", opts.status);
        params.set("limit", String(PAGE_SIZE));
        params.set("offset", String(opts.page * PAGE_SIZE));

        const res = await apiFetch<{ entries: ArchiveEntryDto[]; total: number }>(
          `/api/archives?${params.toString()}`,
        );
        setEntries(res.entries);
        setTotal(res.total);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to search the archives");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Load the house filter options once.
  useEffect(() => {
    apiFetch<{ houses: HouseDto[] }>("/api/houses?includeArchived=true&includeHighLord=true")
      .then((res) => setHouses(res.houses))
      .catch(() => {
        /* filters degrade to "all houses" */
      });
  }, []);

  // Refetch when filters/page change.
  useEffect(() => {
    void load({ q: query, houseId, status, page });
  }, [query, houseId, status, page, load]);

  /** Any filter change resets to page 0. */
  function applyFilter<T>(setter: (v: T) => void, value: T) {
    setPage(0);
    setter(value);
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <PageHeader
        title="Archives"
        subtitle="Search the completed, failed, and cancelled history of the city's houses."
        actions={
          <Button
            variant="outline"
            onClick={() => void load({ q: query, houseId, status, page })}
            disabled={loading}
            data-testid="archives-refresh"
          >
            <RefreshCw className="mr-1 h-4 w-4" /> Refresh
          </Button>
        }
      />

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div className="min-w-[16rem] flex-1 space-y-1">
            <label htmlFor="archive-q" className="text-xs font-medium text-muted-foreground">
              Search text
            </label>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                id="archive-q"
                value={query}
                onChange={(e) => applyFilter(setQuery, e.target.value)}
                placeholder="Search titles, descriptions, results…"
                className="pl-8"
                data-testid="archives-search"
              />
            </div>
          </div>
          <div className="w-[13rem] space-y-1">
            <label className="text-xs font-medium text-muted-foreground">House</label>
            <Select value={houseId} onValueChange={(v) => applyFilter(setHouseId, v)}>
              <SelectTrigger data-testid="archives-house-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All houses</SelectItem>
                {houses.map((h) => (
                  <SelectItem key={h.id} value={h.id}>
                    {h.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-[11rem] space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Status</label>
            <Select value={status} onValueChange={(v) => applyFilter(setStatus, v)}>
              <SelectTrigger data-testid="archives-status-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
            <span data-testid="archives-total">
              {total} archived {total === 1 ? "entry" : "entries"}
            </span>
            <span>
              Page {page + 1} of {pageCount}
            </span>
          </div>

          {loading ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Consulting the archives…
            </p>
          ) : entries.length === 0 ? (
            <div className="py-14 text-center" data-testid="archives-empty">
              <Library className="mx-auto h-10 w-10 text-velaris-silver-muted" />
              <p className="mt-3 font-serif-display text-xl text-foreground">
                Nothing matches your search.
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Completed, failed, and cancelled work will be recorded here.
              </p>
            </div>
          ) : (
            <Table data-testid="archives-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Task</TableHead>
                  <TableHead>House</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead>Archived</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.taskId} data-testid={`archive-row-${entry.taskId}`}>
                    <TableCell className="max-w-[24rem]">
                      <div className="font-medium text-foreground">{entry.title}</div>
                      {entry.summarySnippet ? (
                        <div className="truncate text-xs text-muted-foreground">
                          {entry.summarySnippet}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {entry.houseId ? (
                        <Link
                          href={`/houses/${entry.houseId}`}
                          className="text-primary hover:underline"
                        >
                          {entry.houseName ?? entry.houseId}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <TaskStatusBadge status={entry.status} />
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{entry.type}</Badge>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {entry.sessionCount}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      ${entry.cost.toFixed(4)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <time dateTime={entry.createdAt}>
                        {new Date(entry.createdAt).toLocaleString()}
                      </time>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {total > PAGE_SIZE ? (
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0 || loading}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                data-testid="archives-prev"
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= pageCount - 1 || loading}
                onClick={() => setPage((p) => p + 1)}
                data-testid="archives-next"
              >
                Next
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
