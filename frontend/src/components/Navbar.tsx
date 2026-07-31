'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, Package, ShoppingCart, Bell,
  ClipboardList, CalendarClock, Rocket, Sparkles, MessageSquare, Mail
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ModeToggle } from '@/components/mode-toggle';

const links = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/products', label: 'Products', icon: Package },
  { href: '/orders', label: 'Orders', icon: ShoppingCart },
  { href: '/inventory', label: 'Inventory', icon: Bell },
  { href: '/descriptions', label: 'Descriptions', icon: MessageSquare },
  { href: '/email-test', label: 'Email Test', icon: Mail },
  { href: '/logs', label: 'Logs', icon: ClipboardList },
  { href: '/scheduler', label: 'Scheduler', icon: CalendarClock },
];

export default function Navbar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/90 px-4 py-3 backdrop-blur-xl sm:px-6">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-3 shrink-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/25">
            <Rocket className="h-4 w-4" />
          </div>
          <div className="hidden sm:block">
            <h1 className="text-sm font-bold tracking-tight text-foreground">Ops Autopilot</h1>
          </div>
        </Link>

        {/* Nav */}
        <nav className="flex items-center gap-0.5 rounded-lg border border-border/60 bg-card p-1 overflow-x-auto">
          {links.map((link) => {
            const isActive = pathname === link.href;
            const Icon = link.icon;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors',
                  isActive
                    ? 'bg-primary/15 text-primary shadow-sm'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden md:inline">{link.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Theme toggle */}
        <ModeToggle />
      </div>
    </header>
  );
}
