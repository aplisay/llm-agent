#!/bin/bash

# Usage: ./gh-issues-by-label.sh <LABEL_NAME>
# Example: ./gh-issues-by-label.sh "bug"

LABEL="${1:-bug}"  # Default to "bug" if no label provided

gh issue list \
  --label "$LABEL" \
  --json number,title,labels,milestone \
  --limit 1000 \
  | jq -r '
    # Sort by milestone title (nulls last), then by issue number
    . as $issues |
    # Output header row
    ["ID", "Title", "Labels", "Milestone"] | @tsv,
    # Output data rows
    ($issues | sort_by((.milestone // {}).title // "zzz-no-milestone", .number) | .[] | [
      (.number | tostring),
      .title,
      (.labels | map(.name) | join(", ")),
      (if .milestone then .milestone.title else "No milestone" end)
    ] | @tsv)
  ' \
  | column -t -s $'\t'

