// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { ShortId } from "./ShortId";

const meta = {
  title: "components/ShortId",
  component: ShortId,
  args: {
    id: "89a92ad2-4250-4ebc-9784-b53c731cb402",
    label: "submission ID",
  },
} satisfies Meta<typeof ShortId>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Run detail exposes the full submission ID and a copy action on hover. */
export const SubmissionId: Story = {};
