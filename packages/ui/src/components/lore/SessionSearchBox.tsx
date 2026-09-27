import type { Component } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { sessionsHref } from "~/routes/Browse";
import { Button } from "../ui/button";
import { TextField, TextFieldInput } from "../ui/text-field";

/**
 * Sessions-list title/id search (#1921). Submit-driven (no debounce): the
 * query lives in the URL (`?q=`), so the box simply navigates — Enter
 * submits, an empty submit clears the filter, and a new query always resets
 * the cursor.
 */
export const SessionSearchBox: Component<{
  projectId: string;
  q: string;
}> = (props) => {
  const navigate = useNavigate();
  return (
    <form
      role="search"
      class="mb-4 flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const raw = new FormData(event.currentTarget).get("q");
        const q = typeof raw === "string" ? raw.trim() : "";
        navigate(sessionsHref(props.projectId, null, q || null));
      }}
    >
      <TextField class="min-w-0 flex-1">
        <TextFieldInput
          type="search"
          name="q"
          value={props.q}
          aria-label="Search sessions"
          placeholder="Search sessions by title or id"
        />
      </TextField>
      <Button type="submit" size="sm">
        Search
      </Button>
    </form>
  );
};
