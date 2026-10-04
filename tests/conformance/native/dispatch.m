#import <Foundation/Foundation.h>

@protocol ReaDispatchProtocol
- (void)performAction:(id)sender;
@optional
- (int)optionalFixtureValue;
@end

@interface ReaDispatchFixture : NSObject <ReaDispatchProtocol> {
  int state;
}
- (void)performAction:(id)sender;
+ (int)fixtureVersion;
@end
@implementation ReaDispatchFixture
- (void)performAction:(id)sender { state += sender == nil ? 1 : 2; }
+ (int)fixtureVersion { return 1; }
@end
int main(void) { return 0; }
