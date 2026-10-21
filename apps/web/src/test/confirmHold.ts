import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/** A hold button, activated the accessible way: click it, then confirm with a tap in the row it opens. */
export async function confirmHold(user: UserEvent, testId: string, scope: { getByTestId: (id: string) => HTMLElement } = screen): Promise<void> {
  await user.click(scope.getByTestId(testId));
  await user.click(screen.getByTestId(`${testId}-tap`));
}
