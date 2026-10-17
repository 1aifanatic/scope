// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { NoAccessView } from "./AccessShell";

const meta = {
  component: NoAccessView,
  tags: ["ai-generated", "needs-work"],
  args: { userId: "11111111-2222-4333-8444-555555555555", onLogout: () => {} },
} satisfies Meta<typeof NoAccessView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const EnrolledWithoutMembership: Story = {
  render: args => {
    const [signedOut, setSignedOut] = useState(false);
    return signedOut ? <p>Signed out</p> : <NoAccessView {...args} onLogout={() => setSignedOut(true)} />;
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { name: "No project access" })).toBeVisible();
    await expect(canvas.getByText(meta.args.userId)).toBeVisible();
    await expect(canvas.queryByRole("link")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Sign out" }));
    await expect(canvas.getByText("Signed out")).toBeVisible();
  },
};
