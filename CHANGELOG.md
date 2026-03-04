# Changelog

All notable changes to the MailMind Chrome Extension will be documented in this file.

## [Unreleased]

### Fixed - 2025-10-12
- **CSS Conflict Resolution**: Fixed critical CSS styling issues between single-email and multi-email sidebars
  - Scoped all single-sidebar CSS selectors to `.mailmind-sidebar` parent
  - Scoped all multi-sidebar CSS selectors to `.mailmind-multi-sidebar` parent
  - Moved style loading to initialization phase to ensure both stylesheets are available from start
  - Prevented CSS conflicts by using descendant selectors for proper isolation
  - Both sidebars now maintain correct styling regardless of usage order

### Changed - 2025-10-12
- Optimized style injection: Both `addSidebarStyles()` and `addMultiSidebarStyles()` are now called during initialization
- Removed redundant style loading calls from sidebar creation functions
- Standardized style injection method using `insertBefore()` for consistent loading order

### Technical Details
**Problem**: When using one feature first (single or multi-email), then switching to the other, the CSS would break because:
1. Styles were loaded lazily (only when sidebars were created)
2. Both stylesheets used identical class names (`.mailmind-sidebar-header`, `.mailmind-sidebar-content`, etc.)
3. Multi-sidebar styles with `!important` were overriding single-sidebar styles

**Solution**: 
1. Load both stylesheets during initialization
2. Scope all CSS rules to their respective parent containers
3. Ensure complete CSS isolation between the two sidebar types

## [Previous] - 2025-10-11
### Added
- Initial multi-email selection feature
- Email summary caching and queueing system
- Hide/show functionality for sidebars
- Custom reply generation feature
