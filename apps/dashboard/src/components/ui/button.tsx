/**
 * Button component.
 *
 * Primary actions are inverted monochrome: bg-primary resolves to --fg and
 * text-primary-foreground to --bg, so the main verb on any screen is a
 * solid ink block in light theme and a solid paper block in dark theme.
 * The brand accent never fills buttons; it appears on links, focus rings,
 * and active states only.
 *
 * Disabled buttons do not use opacity. A solid muted surface with muted
 * text reads as intentionally inactive; a faded accent reads as a bug.
 *
 * Focus: 2px ring in --ring with a 2px offset against the page background,
 * via focus-visible so pointer users never see it.
 */
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-body font-medium transition-[color,background-color,border-color,box-shadow] duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/85 disabled:bg-sunken disabled:text-muted-foreground",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:bg-sunken disabled:text-muted-foreground",
        outline:
          "border border-input bg-transparent text-foreground hover:bg-hover disabled:text-muted-foreground disabled:border-border",
        secondary:
          "bg-secondary text-secondary-foreground border border-border hover:bg-sunken disabled:text-muted-foreground",
        ghost:
          "text-muted-foreground hover:bg-hover hover:text-foreground disabled:text-subtle-foreground",
        link: "text-accent-text underline-offset-4 hover:underline disabled:text-muted-foreground disabled:no-underline",
      },
      size: {
        default: "h-10 px-4",
        sm: "h-9 px-3.5 text-small",
        lg: "h-11 px-6",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
